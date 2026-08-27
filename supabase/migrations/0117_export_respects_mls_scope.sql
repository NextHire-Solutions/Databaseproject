-- 0117 (A4) — exports follow the same MLS-scoped numbers the screen shows.
--
-- THE BUG, as the client sees it: a saved view capped at $10M exports a CSV whose first row
-- reads $18,641,200. A "$0-5M" view exports a CSV opening at $188,992,556.
--
-- WHAT IS ACTUALLY HAPPENING: when every selected MLS clears the 90% stats-coverage gate, the
-- A5 scoped rules reinterpret a production filter as "within the selected MLS". fn_agent_where
-- stops emitting `sales_volume <= 10000000` against agents and emits instead
--   id in (select agent_id from agent_mls_stats where mls_id = any(...) group by agent_id
--          having sum(sales_volume) <= 10000000)
-- The SCREEN was taught to match: fn_filter_search joins the same per-MLS aggregate, shows its
-- numbers, and sorts by them. Three of the four consumers were updated. The export was not, and
-- it is downstream of BOTH halves:
--   (a) fn_filter_ids orders by fn_agent_order, which only knows agents.* — so the export is
--       ordered by the all-MLS rollup, the column the filter was NOT applied to. Every agent
--       whose rollup exceeds the cap sorts to the TOP of the file (rows 1-19 on The Karp Group),
--       which is why it reads as "the cap did nothing". Worse, for a RANGED export the ordering
--       decides membership: rows 1-100 of the export shared only 82 agents with page 1 on screen.
--   (b) the row fetch is `select a.*`, so the printed Sales volume is that same rollup.
--
-- Measured before this migration (production, read-only):
--   The Karp Group   cap $10M, FTL      2,826 ids, 19 over cap, max $18,641,200
--   Camelot Realty   "$0-5M", HAR      33,916 ids, 27 over cap, max $188,992,556
--   Norvell&Co       "$0-5M"                       91 over cap, max  $60,168,570
--   BHS Base Camp    cap $7M, CVR                   8 over cap, max  $20,365,692
--   Carolina Realty  cap $4M, CANOPY               24 over cap, max  $36,526,300
--   Simien Props     cap $7M, HAR                   8 over cap, max  $24,252,769
-- Negative control: The Oz Group (MORE coverage 0.864, below the gate) is NOT scoped, gets the
-- plain agents-level predicate, and leaks nothing — confirming the mechanism.
--
-- THE FIX: give the export the same two things the screen already has.
--   fn_scoped_mls()  — the gate, in one place, so every consumer agrees on when scoping applies.
--   fn_filter_ids    — orders by the scoped aggregate when the sort is a production metric.
--   fn_export_rows() — returns rows with the scoped metrics overlaid, in id order.
-- The CSV route and the Clay webhook both gather rows through gather-rows.ts, so both are fixed
-- by the same change; /api/portal/export and clay/retry only emit identity fields and are
-- unaffected either way.
--
-- NOT the fix: adding `sales_volume <= cap` back at the agents level. That would contradict the
-- scoped semantics the client signed off in July and silently drop agents the screen legitimately
-- shows — the screen is right, the export was lying about it.

-- The A5 gate, extracted verbatim from fn_filter_search so the two can never disagree.
-- Returns the selected MLS ids when EVERY one has near-complete per-MLS stats, else null.
create or replace function public.fn_scoped_mls(p_filters jsonb)
returns uuid[]
language plpgsql
stable
set search_path to 'public'
as $$
declare sel uuid[]; ok boolean;
begin
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) = 0 then return null; end if;
  sel := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
  select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
    into ok from mls where id = any(sel);
  if coalesce(ok, false) then return sel; end if;
  return null;
end;
$$;

-- Which production metrics have a scoped equivalent (same list the screen sorts by).
create or replace function public.fn_scoped_sort_col(p_sort_by text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case coalesce(p_sort_by, 'sales_volume')
    when 'sales_volume' then 'sales_volume' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
    when 'closed_transactions' then 'closed_transactions' when 'approx_gci' then 'approx_gci'
    when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
    when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
    when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
    when 'pct_change' then 'pct_change' else null end;
$$;

-- The per-agent aggregate over the selected MLSs, as SQL text. Identical column list and
-- weighting to fn_filter_search's v_sc, so the export and the screen compute the same numbers.
create or replace function public.fn_scoped_stats_sql(p_mls uuid[])
returns text
language sql
immutable
set search_path to 'public'
as $$
  select format($sc$(select agent_id,
      sum(sales_volume) as sales_volume, sum(buy_side_dollar) as buy_side_dollar,
      sum(list_side_dollar) as list_side_dollar, sum(approx_gci) as approx_gci,
      sum(closed_transactions) as closed_transactions, sum(units) as units,
      sum(buy_side_count) as buy_side_count, sum(list_side_count) as list_side_count,
      sum(closed_rentals) as closed_rentals,
      case when sum(units) > 0 then sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / sum(units) end as avg_sale_price,
      case when sum(closed_rentals) > 0 then sum(coalesce(avg_rental_price, 0) * coalesce(closed_rentals, 0)) / sum(closed_rentals) end as avg_rental_price,
      case when sum(prev_sales_volume) > 0 then (sum(sales_volume) - sum(prev_sales_volume)) / sum(prev_sales_volume) * 100 end as pct_change
    from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id)$sc$, p_mls);
$$;

-- fn_filter_ids: order by the scoped aggregate when the view is scoped and the sort is a
-- production metric. Everything else — office mode, the 'random' sample from 0115, and every
-- non-metric sort — is byte-identical to before.
create or replace function public.fn_filter_ids(
  p_mode text default 'agent',
  p_source text default 'courted',
  p_filters jsonb default '{}'::jsonb,
  p_sort_by text default 'sales_volume',
  p_sort_dir text default 'desc',
  p_limit integer default 100000,
  p_offset integer default 0)
returns uuid[]
language plpgsql
stable security definer
set search_path to 'public'
set work_mem to '128MB'
as $function$
declare v_where text; v_order text; v_ids uuid[]; v_mls uuid[]; v_scord text; v_dir text;
begin
  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
  else
    v_where := fn_agent_where(p_source, p_filters);
  end if;

  if p_sort_by = 'random' then
    -- stable pseudo-random order (0115): spread sample, still range-safe
    v_order := 'md5(a.id::text)';
  elsif p_mode = 'office' then
    v_order := format('%I %s nulls last',
      case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count'
        when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' else 'sales_volume' end,
      case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
  else
    v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);
  end if;

  -- A4: scoped ordering for agent exports. Without this the export is ordered by the all-MLS
  -- rollup while the filter was applied to the per-MLS sum, so over-cap agents lead the file
  -- and a ranged export selects agents the operator never saw.
  if p_mode <> 'office' and p_sort_by is distinct from 'random' then
    v_mls := fn_scoped_mls(p_filters);
    v_scord := fn_scoped_sort_col(p_sort_by);
    if v_mls is not null and v_scord is not null then
      v_dir := case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end;
      -- nested loops against the grouped aggregate collapse the same way they do on the screen
      perform set_config('enable_nestloop', 'off', true);
      -- The WHERE is applied to agents BEFORE the sc join: a saved view inlines BARE column
      -- names, so with both relations in scope "sales_volume <= x" would be ambiguous and the
      -- query would error outright (this bit the screen once already).
      execute format(
        'select array_agg(id) from (select a.id from (select a.id from agents a where %s) a
           left join %s sc on sc.agent_id = a.id order by sc.%I %s nulls last, a.id limit %s offset %s) t',
        v_where, fn_scoped_stats_sql(v_mls), v_scord, v_dir, p_limit, p_offset) into v_ids;
      return coalesce(v_ids, '{}');
    end if;
  end if;

  execute format('select array_agg(id) from (select a.id from %I a where %s order by %s limit %s offset %s) t',
    case when p_mode = 'office' then 'offices' else 'agents' end, v_where, v_order, p_limit, p_offset) into v_ids;
  return coalesce(v_ids, '{}');
end;
$function$;

-- Export rows in id order, with the scoped metrics overlaid when p_mls is given. Returns the
-- same shape gather-rows.ts already produces (agents.* plus an `mls` array), so the CSV column
-- map and the Clay row builder need no changes beyond passing the scope through.
create or replace function public.fn_export_rows(p_ids uuid[], p_mls uuid[] default null)
returns jsonb
language sql
stable security definer
set search_path to 'public'
set work_mem to '128MB'
as $$
  select coalesce(jsonb_agg(row_json order by ord), '[]'::jsonb)
    from (
      select u.ord,
             to_jsonb(a)
             || jsonb_build_object('mls',
                  (select jsonb_agg(jsonb_build_object('code', m.code, 'member_id', am.mls_member_id))
                     from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id))
             || case
                  when p_mls is null or array_length(p_mls, 1) is null then '{}'::jsonb
                  -- scoped, but this agent has no stats row for the selected MLS: blank the
                  -- metrics rather than fall back to the rollup, exactly as the screen does.
                  when sc.agent_id is null then jsonb_build_object(
                    'sales_volume', null, 'buy_side_dollar', null, 'list_side_dollar', null,
                    'approx_gci', null, 'closed_transactions', null, 'units', null,
                    'buy_side_count', null, 'list_side_count', null, 'closed_rentals', null,
                    'avg_sale_price', null, 'avg_rental_price', null, 'pct_change', null,
                    'mls_scoped', true)
                  else (to_jsonb(sc) - 'agent_id') || jsonb_build_object('mls_scoped', true)
                end as row_json
        from unnest(p_ids) with ordinality as u(id, ord)
        join agents a on a.id = u.id
        left join (
          select agent_id,
                 sum(sales_volume) as sales_volume, sum(buy_side_dollar) as buy_side_dollar,
                 sum(list_side_dollar) as list_side_dollar, sum(approx_gci) as approx_gci,
                 sum(closed_transactions) as closed_transactions, sum(units) as units,
                 sum(buy_side_count) as buy_side_count, sum(list_side_count) as list_side_count,
                 sum(closed_rentals) as closed_rentals,
                 case when sum(units) > 0 then sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / sum(units) end as avg_sale_price,
                 case when sum(closed_rentals) > 0 then sum(coalesce(avg_rental_price, 0) * coalesce(closed_rentals, 0)) / sum(closed_rentals) end as avg_rental_price,
                 case when sum(prev_sales_volume) > 0 then (sum(sales_volume) - sum(prev_sales_volume)) / sum(prev_sales_volume) * 100 end as pct_change
            from agent_mls_stats
           where p_mls is not null and mls_id = any(p_mls) and agent_id = any(p_ids)
           group by agent_id
        ) sc on sc.agent_id = a.id
    ) t;
$$;
