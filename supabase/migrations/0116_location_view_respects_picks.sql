-- 0116 — the Location view only lists the places you actually picked.
--
-- The bug (reported by the client, reproduced live): selecting 50 cities returned 2,746
-- location rows. The location filter narrows AGENTS, and the Location view then groups each
-- surviving agent by EVERY location they hold. An agent whose office is in Miami (picked)
-- but who most-transacted in Coral Gables (not picked) emitted a Coral Gables row. With 5
-- cities picked the view returned 2,891 rows, 20 of the first 25 outside the selection —
-- Coral Gables, Miami Beach, Alpharetta, Katy, Marietta, all satellites of the 5.
--
-- The fix restricts the EXPANDED LOCATION TUPLES, not the display label. The label carries a
-- raw spelling (min(office_city)), so matching text would drop "St. Petersburg, FL" when the
-- pick was "St Petersburg, FL". Matching on fn_city_match_key + state is exactly what the
-- grouping keys on, so a pick and its row can never disagree.
--
-- It only applies when the pick's level MATCHES the view's granularity. Filtering by county
-- while viewing cities still lists every city in those counties — that combination is the
-- useful one and must not collapse to nothing. Mixed-level picks (0070) are handled per
-- entry, so a city pick and a county pick coexist: each constrains its own level only.

-- Picks at one granularity, from either side of the filter. Honors both plain string entries
-- (which take the filter's current level) and tagged {"f","v"} entries from the mixed-level
-- location filter.
create or replace function public.fn_loc_entries(p_filters jsonb, p_side text)
returns jsonb
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('lvl', lvl, 'v', val)), '[]'::jsonb)
    from (
      select case when jsonb_typeof(e.value) = 'object' then e.value->>'v' else e.value #>> '{}' end as val,
             coalesce(
               case when jsonb_typeof(e.value) = 'object' then nullif(e.value->>'f', '') end,
               case when p_side = 'values'
                    then p_filters->'location'->>'field'
                    else coalesce(nullif(p_filters->'location'->>'excludeField', ''), p_filters->'location'->>'field')
               end) as lvl
        from jsonb_array_elements(coalesce(p_filters->'location'->p_side, '[]'::jsonb)) e
    ) s
   where val is not null and btrim(val) <> '' and lvl is not null;
$$;

-- Builds an OR-list over the grouped location expressions for one set of picks.
-- p_key/p_state/p_cty are the SQL expressions naming the key, state and county in the caller's
-- scope ('a.office_city_key' in the single-basis branch, 'v.ck' in the multi-basis one).
-- Picks are a UNION, and each is evaluated at the finest level the VIEW can express. A city
-- pick and a county pick therefore coexist: viewing cities, the city pick pins its own row
-- while the county pick opens every city inside it. Where the view is coarser than the pick
-- (city picked, counties shown) the pick falls back to its state, which is a superset — it
-- can never hide the place the pick belongs to. An unmappable level does the same, so a new
-- location level can't silently empty the view.
create or replace function public.fn_loc_pick_list(
  p_entries jsonb, p_gran text, p_key text, p_state text, p_cty text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $$
declare e jsonb; lvl text; v text; m text[]; nm text; st text; term text; parts text[] := '{}';
begin
  if p_entries is null or jsonb_array_length(p_entries) = 0 then return null; end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    lvl := e->>'lvl'; v := btrim(e->>'v');
    if lvl = 'state' then
      nm := null; st := upper(v);
    else
      -- "Name, ST" -> name + state; a value with no state suffix matches on name alone
      m := regexp_match(v, '^(.*),\s*([A-Za-z]{2})$');
      if m is null then nm := v; st := null; else nm := btrim(m[1]); st := upper(m[2]); end if;
    end if;

    term := null;
    if lvl = 'state' then
      term := format('%s = %L', p_state, st);
    elsif p_gran = 'state' then
      term := null; -- handled by the state fallback below
    elsif lvl = 'county' then
      term := format('(lower(%s) = %L%s)', p_cty, lower(nm),
                case when st is null then '' else format(' and %s = %L', p_state, st) end);
    elsif lvl = 'city' and p_gran = 'city' then
      term := format('(%s = fn_city_match_key(%L)%s)', p_key, nm,
                case when st is null then '' else format(' and %s = %L', p_state, st) end);
    end if;
    -- coarser view than the pick, or a level this view cannot express: keep its state
    if term is null and st is not null then term := format('%s = %L', p_state, st); end if;

    if term is not null then parts := parts || term; end if;
  end loop;
  if array_length(parts, 1) is null then return null; end if;
  return array_to_string(parts, ' or ');
end;
$$;

-- 'true' when the filter targets a different level than the view — the county-filter /
-- city-view case keeps working untouched.
create or replace function public.fn_loc_pick_cond(
  p_filters jsonb, p_gran text, p_key text, p_state text, p_cty text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $$
declare c_inc text; c_exc text; out text;
begin
  c_inc := fn_loc_pick_list(fn_loc_entries(p_filters, 'values'), p_gran, p_key, p_state, p_cty);
  c_exc := fn_loc_pick_list(fn_loc_entries(p_filters, 'excludeValues'), p_gran, p_key, p_state, p_cty);
  out := case when c_inc is null then 'true' else '(' || c_inc || ')' end;
  if c_exc is not null then out := out || ' and not (' || c_exc || ')'; end if;
  return out;
end;
$$;

-- The Location view itself: both the single-basis and multi-basis paths now constrain
-- their grouped rows to the picks (see fn_loc_pick_cond above).
CREATE OR REPLACE FUNCTION public.fn_filter_search(p_mode text DEFAULT 'agent'::text, p_source text DEFAULT 'courted'::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort_by text DEFAULT 'sales_volume'::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '128MB'
AS $function$
declare v_where text; v_order text; v_sort_col text; v_dir text; v_count bigint; v_volume numeric; v_data jsonb; v_minoff int;
  v_gran text; v_lbl text; v_grp text; v_nn text; v_kind text; v_ccol text; v_kcol text; v_stcol text; v_ctycol text; v_kinds text[]; v_vals text;
  sel_mls uuid[]; scoped boolean := false; v_sc text; v_scord text; v_page uuid[]; v_having text;
  -- Agent Count for Location/MLS. v_having filters the LIVE aggregate (column is `agents`);
  -- v_ccond filters the CACHED rows (column is `s_agents`). Same user input, two grains.
  v_ccond text;
  v_ckey text; -- exact-basis cache key (see 0116b below)
  v_cache jsonb;
begin
  if p_mode = 'mls' then
    -- B8: MLS grain — the filtered agents grouped by MLS membership. A multi-MLS agent
    -- counts under each of their MLSs (same convention as the Location tab's places).
    v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
    -- Agent Count ranges on the OUTPUT row's agent total, so it is not an agent predicate and
    -- fn_agent_where never sees it. That is why it has to be applied explicitly in both paths:
    -- left alone it would be accepted by the UI and silently do nothing on the cached view.
    v_having := coalesce(fn_range_cond('agents', p_filters->'agentCount'), 'true');
    v_ccond  := coalesce(fn_range_cond('s_agents', p_filters->'agentCount'), 'true');
    v_sort_col := case p_sort_by when 'mls' then 'label' when 'agents' then 'agents' when 'offices' then 'offices' when 'units' then 'units' when 'updated' then 'updated' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    -- 0096: unfiltered => serve the precomputed grouped set (4,441 ms -> ~10 ms). The
    -- eligibility test compares the generated WHERE against the no-filter WHERE for this
    -- source, so a filtered request can never read it; a miss returns null and falls straight
    -- through to the live query below.
    if v_where = fn_agent_where(p_source, '{}'::jsonb) then
      v_cache := fn_perf_view_read('mls:' || p_source, v_sort_col, v_dir, p_limit, p_offset, v_ccond);
      if v_cache is not null then return v_cache; end if;
    end if;
    execute format($q$
      with sel as (select a.id, a.office_id, a.sales_volume, a.units from agents a where %s),
      g0 as (
        select m.id as mls_id, coalesce(m.name, m.code) as label, m.code,
               to_char(m.bulk_refreshed_at, 'YYYY-MM-DD') as updated,
               count(*)::bigint as agents, count(distinct sel.office_id)::bigint as offices,
               coalesce(sum(sel.sales_volume), 0)::numeric as sales_volume, coalesce(sum(sel.units), 0)::numeric as units
          from sel
          join agent_mls am on am.agent_id = sel.id
          join mls m on m.id = am.mls_id
         group by m.id, m.name, m.code, m.bulk_refreshed_at
      ), g as (select * from g0 where %s)
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, label asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_having, v_sort_col, v_dir, p_limit, p_offset)
    into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'location' then
    -- D4 + Stephanie's follow-up: location grain over a chosen BASIS — the agent's office,
    -- home, or most-transacted location, or ALL three combined (an agent counts once per
    -- place even when several of their locations land in the same place).
    v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
    v_gran := case p_filters->>'locGranularity' when 'county' then 'county' when 'city' then 'city' else 'state' end;
    -- multi-select basis: locKinds = any subset of office/home/transacted (legacy locKind honored)
    v_kinds := array(select x from jsonb_array_elements_text(coalesce(p_filters->'locKinds', '[]'::jsonb)) x
                      where x in ('office', 'home', 'transacted'));
    if array_length(v_kinds, 1) is null then
      v_kinds := case p_filters->>'locKind'
        when 'home' then array['home'] when 'transacted' then array['transacted']
        when 'all' then array['office', 'home', 'transacted'] else array['office'] end;
    end if;
    v_kind := case when array_length(v_kinds, 1) = 1 then v_kinds[1] else 'all' end;
    -- 0116b: the CACHE key must name the exact basis set. v_kind collapses every multi-basis
    -- pick to 'all', which is right for choosing the query branch but wrong as a cache key:
    -- Office+Transacted and Office+Home were both reading the cache built for all THREE
    -- bases, returning identical rows and totals, so toggling Home changed nothing on the
    -- unfiltered view. Only the one- and three-basis sets are precomputed; any other
    -- combination now misses and falls through to the live query, which is correct.
    v_ckey := case when array_length(v_kinds, 1) = 1 then v_kinds[1]
                   when array_length(v_kinds, 1) = 3 then 'all'
                   else array_to_string(array(select unnest(v_kinds) order by 1), '+') end;
    v_having := coalesce(fn_range_cond('agents', p_filters->'agentCount'), 'true');
    v_ccond  := coalesce(fn_range_cond('s_agents', p_filters->'agentCount'), 'true');
    v_sort_col := case p_sort_by when 'location' then 'location' when 'agents' then 'agents' when 'offices' then 'offices' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    -- 0096: unfiltered => serve the precomputed grouped set. Biggest win in the app: the
    -- all-three-basis views cost 18-23 s live, because every agent expands to three rows
    -- before dedup. Keyed by source + granularity + basis; anything not populated falls
    -- through to the live query unchanged.
    if v_where = fn_agent_where(p_source, '{}'::jsonb) then
      v_cache := fn_perf_view_read('location:' || p_source || ':' || v_gran || ':' || v_ckey,
                                   v_sort_col, v_dir, p_limit, p_offset, v_ccond);
      if v_cache is not null then return v_cache; end if;
    end if;

    if v_kind <> 'all' then
      if v_kind = 'office' then v_ccol := 'office_city'; v_kcol := 'office_city_key'; v_stcol := 'office_state'; v_ctycol := 'office_county';
      elsif v_kind = 'home' then v_ccol := 'home_city'; v_kcol := 'home_city_key'; v_stcol := 'home_state'; v_ctycol := 'home_county';
      else v_ccol := 'most_transacted_city'; v_kcol := 'most_transacted_city_key'; v_stcol := 'transacted_state'; v_ctycol := 'most_transacted_county';
      end if;
      if v_gran = 'state' then
        v_lbl := format('upper(a.%I)', v_stcol); v_grp := format('upper(a.%I)', v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L', v_stcol, v_stcol, '');
      elsif v_gran = 'county' then
        v_lbl := format('initcap(min(a.%I)) || %L || upper(a.%I)', v_ctycol, ', ', v_stcol);
        v_grp := format('lower(a.%I), upper(a.%I)', v_ctycol, v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L and a.%I is not null', v_ctycol, v_ctycol, '', v_stcol);
      else
        v_lbl := format('min(a.%I) || %L || upper(a.%I)', v_ccol, ', ', v_stcol);
        v_grp := format('a.%I, upper(a.%I)', v_kcol, v_stcol);
        v_nn := format('a.%I is not null and a.%I is not null', v_kcol, v_stcol);
      end if;
      -- 0116: list only the places actually picked. Without this the filter narrows AGENTS
      -- and each survivor still groups under EVERY location they hold, so picking 50 cities
      -- returned thousands of rows. Matches on the same key the grouping uses, and is a
      -- no-op when the picks are at a different level than the view.
      v_nn := v_nn || ' and ' || fn_loc_pick_cond(p_filters, v_gran,
                format('a.%I', v_kcol), format('upper(a.%I)', v_stcol), format('a.%I', v_ctycol));
      execute format($q$
        with g0 as (
          select %s as location, count(*)::bigint as agents, count(distinct a.office_id)::bigint as offices,
                 coalesce(sum(a.sales_volume), 0)::numeric as sales_volume, coalesce(sum(a.units), 0)::numeric as units
            from agents a
           where (%s) and %s
           group by %s
        ), g as (select * from g0 where %s)
        select (select count(*) from g),
               (select coalesce(sum(sales_volume), 0) from g),
               coalesce((select jsonb_agg(to_jsonb(t)) from (
                  select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
      $q$, v_lbl, v_where, v_nn, v_grp, v_having, v_sort_col, v_dir, p_limit, p_offset)
      into v_count, v_volume, v_data;
      return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
    end if;

    -- Multi-kind basis: expand each agent to the SELECTED kinds' tuples, dedup to one row
    -- per (place, agent), then aggregate — a place's numbers never double-count an agent.
    v_vals := array_to_string(array(
      select case k
        when 'office' then '(a.office_city_key, a.office_city, upper(a.office_state), a.office_county)'
        when 'home' then '(a.home_city_key, a.home_city, upper(a.home_state), a.home_county)'
        else '(a.most_transacted_city_key, a.most_transacted_city, upper(a.transacted_state), a.most_transacted_county)'
      end from unnest(v_kinds) k), ', ');
    if v_gran = 'state' then
      v_grp := 'v.st'; v_lbl := 'p.gkey'; v_nn := 'v.st is not null'; v_ccol := 'min(v.rawc)';
    elsif v_gran = 'county' then
      v_grp := 'lower(v.cty)'; v_lbl := $c$initcap(n.disp) || ', ' || p.gst$c$;
      v_nn := $c$v.cty is not null and btrim(v.cty) <> '' and v.st is not null$c$;
      v_ccol := 'min(v.cty)'; -- display = the county's raw spelling
    else
      v_grp := 'v.ck'; v_lbl := $c$n.disp || ', ' || p.gst$c$;
      v_nn := 'v.ck is not null and v.st is not null';
      v_ccol := 'min(v.rawc)'; -- display = the city's raw spelling
    end if;
    -- 0116: same restriction on the multi-basis path, applied to the EXPANDED tuples — an
    -- agent contributes a row only for the locations that were actually picked, instead of
    -- dragging in every other city they happen to sit in.
    v_nn := v_nn || ' and ' || fn_loc_pick_cond(p_filters, v_gran, 'v.ck', 'v.st', 'v.cty');
    execute format($q$
      with lat as (
        select a.id, a.office_id, a.sales_volume, a.units, v.ck, v.rawc, v.st, v.cty
          from agents a
          cross join lateral (values %s) v(ck, rawc, st, cty)
         where (%s) and %s
      ),
      pairs as (
        select distinct %s as gkey, v.st as gst, id, office_id, sales_volume, units from lat v
      ),
      names as (
        select %s as gkey, v.st as gst, %s as disp from lat v group by 1, 2
      ),
      g0 as (
        select %s as location, count(*)::bigint as agents, count(distinct p.office_id)::bigint as offices,
               coalesce(sum(p.sales_volume), 0)::numeric as sales_volume, coalesce(sum(p.units), 0)::numeric as units
          from pairs p left join names n on n.gkey = p.gkey and n.gst is not distinct from p.gst
         group by p.gkey, p.gst, n.disp
      ), g as (select * from g0 where %s)
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_vals, v_where, v_nn, v_grp, v_grp, v_ccol, v_lbl, v_having, v_sort_col, v_dir, p_limit, p_offset)
    into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'brand' then
    -- B5: brand grain = GROUP BY brand over the (filtered) offices table. Office-level
    -- filters apply per office BEFORE aggregation. Single-office "brands" are just the
    -- brokerage's own name (91k of 97k), so they are hidden unless the caller passes
    -- includeSingleOfficeBrands=true.
    -- "Agent Count" in the Brand view means agents in the BRAND, so it is applied to the
    -- brand total AFTER grouping. It used to be handed to fn_office_where, which put it in
    -- the WHERE that runs BEFORE "group by brand" -- so it actually asked "which OFFICES
    -- have N agents", then summed whichever offices survived. Two wrong answers came out of
    -- that: brands built from many small offices disappeared entirely (min=100 showed 93 of
    -- the 471 brands that really have 100+ agents -- NextHome, 2,588 agents across 415
    -- offices, was hidden because no single office reaches 100), and the Agent Count column
    -- showed a partial sum for the brands that did survive (Keller Williams read 64,302
    -- instead of 84,509). Office view keeps the per-office meaning, which is correct there.
    v_where  := fn_office_where(coalesce(p_filters, '{}'::jsonb) - 'agentCount');
    -- Office and Brand were missing this. A saved view carrying an MLS plus a range filter puts a
    -- grouped agent_mls_stats subquery into the office WHERE too (via the saved-view block that
    -- resolves the view at agent grain), and the planner mis-estimates it exactly as it does at
    -- agent grain. Measured on the BHS Base Camp view: office 2,140 ms with nested loops, 191 ms
    -- without.
    perform fn_nestloop_guard(v_where);
    v_having := coalesce(fn_range_cond('agent_count', p_filters->'agentCount'), 'true');
    v_sort_col := case p_sort_by when 'brand' then 'brand' when 'office_count' then 'office_count' when 'agent_count' then 'agent_count' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    v_minoff := case when coalesce(p_filters->>'includeSingleOfficeBrands', '') = 'true' then 1 else 2 end;
    execute format($q$
      with g0 as (
        select brand, count(*)::int as office_count, coalesce(sum(agent_count), 0)::bigint as agent_count,
               coalesce(sum(sales_volume), 0)::numeric as sales_volume, coalesce(sum(units), 0)::numeric as units
          from offices
         where (%s) and brand is not null and btrim(brand) <> ''
         group by brand
        having count(*) >= %s
      ), g as (select * from g0 where %s)
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, brand asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_minoff, v_having, v_sort_col, v_dir, p_limit, p_offset) into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
    -- Office and Brand were missing this. A saved view carrying an MLS plus a range filter puts a
    -- grouped agent_mls_stats subquery into the office WHERE too (via the saved-view block that
    -- resolves the view at agent grain), and the planner mis-estimates it exactly as it does at
    -- agent grain. Measured on the BHS Base Camp view: office 2,140 ms with nested loops, 191 ms
    -- without.
    perform fn_nestloop_guard(v_where);
    v_sort_col := case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count' when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' when 'brand' then 'brand' when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    execute format('select count(*), coalesce(sum(sales_volume), 0) from offices where %s', v_where) into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t.j), '[]'::jsonb) from (
        select to_jsonb(o) || jsonb_build_object(
                 'agent_names', (select coalesce(jsonb_agg(ag.full_name order by ag.sv desc nulls last), '[]'::jsonb)
                                  from (select full_name, sales_volume sv from agents where office_id = o.id order by sales_volume desc nulls last limit 25) ag)
               ) as j
        from offices o where %s order by o.%I %s nulls last limit %s offset %s
      ) t $q$, v_where, v_sort_col, v_dir, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
  v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);

  -- A5 phase 3: when every selected MLS has near-complete stats coverage, the table
  -- shows (and sorts by) THAT MLS's numbers — same gate as fn_agent_where's filters.
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) > 0 then
    sel_mls := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
    select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
      into scoped from mls where id = any(sel_mls);
    scoped := coalesce(scoped, false);
  end if;

  if scoped then
    -- A5 scoped branch only: keep the planner off nested loops.
    --
    -- This branch left-joins agents to a per-agent aggregate of agent_mls_stats, and the WHERE
    -- carries two more agent_mls_stats subqueries (the MLS membership semi-join, and the sales
    -- volume filter, which becomes "id in (select agent_id ... group by agent_id having
    -- sum(...))" once an MLS is selected). None of those are estimable: the location filter is
    -- an OR across three column pairs wrapped in coalesce/fn_city_embedded_state, and the title
    -- filter is fn_title_tokens(title) && array. The planner has no statistics for expressions
    -- like those, so selectivities multiply as if independent and the estimate collapses.
    --
    -- Reported by the client as "stuck for 20 seconds" on Location + Sales volume + Office
    -- search + MLS + Title. Measured: estimate 3 rows, actual 160, and it chose a nested loop
    -- against the grouped agent_mls_stats subquery -- one grouped aggregate lookup per outer
    -- row. The count alone ran past 120 s. With nested loops off it is 606 ms; the same query
    -- through fn_filter_search, 2.1 s.
    --
    -- Extended statistics were tried first (stx_agents_office_geo and friends, still in place
    -- and useful elsewhere) -- they did not help here, because the problem is expression
    -- predicates rather than cross-column correlation.
    --
    -- Checked against every scoped combination before shipping; hash/merge plans were faster or
    -- within noise in all of them, so nothing trades away for this:
    --     MLS only        826 -> 693 ms      MLS + city    278 -> 289 ms
    --     MLS + volume  1,070 -> 699 ms      MLS + brand   435 -> 365 ms
    --     MLS + title     465 -> 462 ms      FULL SET    >60,000 -> 2,099 ms
    --
    -- The scoped branch always left-joins the grouped agent_mls_stats aggregate, and that join
    -- lives in the SELECT rather than the WHERE -- so fn_nestloop_guard's inspection of v_where
    -- does not see it. Fire the guard unconditionally here. (Missing this cost MLS-only
    -- searches 693 -> 3,897 ms in testing.)
    perform set_config('enable_nestloop', 'off', true);
    v_sc := format($sc$(select agent_id,
        sum(sales_volume) as sales_volume, sum(buy_side_dollar) as buy_side_dollar,
        sum(list_side_dollar) as list_side_dollar, sum(approx_gci) as approx_gci,
        sum(closed_transactions) as closed_transactions, sum(units) as units,
        sum(buy_side_count) as buy_side_count, sum(list_side_count) as list_side_count,
        sum(closed_rentals) as closed_rentals,
        case when sum(units) > 0 then sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / sum(units) end as avg_sale_price,
        case when sum(closed_rentals) > 0 then sum(coalesce(avg_rental_price, 0) * coalesce(closed_rentals, 0)) / sum(closed_rentals) end as avg_rental_price,
        case when sum(prev_sales_volume) > 0 then (sum(sales_volume) - sum(prev_sales_volume)) / sum(prev_sales_volume) * 100 end as pct_change
      from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id)$sc$, sel_mls);
    -- scoped sort for production columns; everything else keeps the normal order
    v_scord := case coalesce(p_sort_by, 'sales_volume')
      when 'sales_volume' then 'sales_volume' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
      when 'closed_transactions' then 'closed_transactions' when 'approx_gci' then 'approx_gci'
      when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
      when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
      when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
      when 'pct_change' then 'pct_change' else null end;
    if v_scord is not null then
      v_order := format('sc.%I %s nulls last', v_scord, case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end);
    end if;
    -- The WHERE is applied to agents BEFORE the sc join, not after it. sc exposes the same
    -- metric names agents does (sales_volume, units, closed_transactions, approx_gci,
    -- buy_side_dollar, ...), and a saved view inlines its conditions using BARE column names,
    -- so with both relations in scope a view's "sales_volume <= 4000000" was ambiguous and the
    -- whole search failed with a SQL error -- 5 of 16 live saved views, the moment an MLS filter
    -- was also selected. Filtering first leaves only agents in scope.
    execute format('select count(*), coalesce(sum(sc.sales_volume), 0) from (select a.id from agents a where %s) a left join %s sc on sc.agent_id = a.id', v_where, v_sc)
      into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select to_jsonb(a)
            || case when sc.agent_id is null
                 then jsonb_build_object('sales_volume', null, 'buy_side_dollar', null, 'list_side_dollar', null,
                        'approx_gci', null, 'closed_transactions', null, 'units', null, 'buy_side_count', null,
                        'list_side_count', null, 'closed_rentals', null, 'avg_sale_price', null,
                        'avg_rental_price', null, 'pct_change', null)
                 else to_jsonb(sc) - 'agent_id' end
            || jsonb_build_object('mls_scoped', true,
                 'mls', (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
                           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id),
                 'source_stats', (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
                                    from agent_source_stats s where s.agent_id = a.id),
                 'client_campaigns', (select string_agg(distinct c.client_name, ', ' order by c.client_name)
                                        from v_agent_campaigns b join orch_clients c on c.id = b.client_id
                                       where b.agent_id = a.id),
                 'campaign_count', (select count(distinct b5.campaign_id) from v_agent_campaigns b5 where b5.agent_id = a.id),
                 'has_replied', exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id),
                 'has_bounced', exists(select 1 from v_bounced_agents b4 where b4.agent_id = a.id),
                 'reply_providers', (select rs.reply_providers from v_agent_reply_sources rs where rs.agent_id = a.id),
                 'reply_campaigns', (select rs.reply_campaigns from v_agent_reply_sources rs where rs.agent_id = a.id)) as t
        from (select a.* from agents a where %s) a left join %s sc on sc.agent_id = a.id order by %s, a.id limit %s offset %s
      ) t $q$, v_where, v_sc, v_order, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  -- A12: sort by client campaign — the per-agent campaign list is aggregated ONCE
  -- (50k rows) and hash-joined, never computed per row in the sort.
  -- Retired: fn_agent_page_ids now sorts client_campaigns on the narrow path together with the
  -- other computed sorts, so this branch is no longer reached. Sorting by Client campaign still
  -- works and is far faster; the only visible change is that ties break on a.id rather than
  -- sales_volume, which makes paging deterministic. Left in place rather than deleted.
  if false and p_sort_by = 'client_campaigns' and not scoped then
    execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select a.*,
          (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
             from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
          (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
             from agent_source_stats s where s.agent_id = a.id) as source_stats,
          cc.cn as client_campaigns,
          (select count(distinct b5.campaign_id) from v_agent_campaigns b5 where b5.agent_id = a.id) as campaign_count,
          exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
          exists(select 1 from v_bounced_agents b4 where b4.agent_id = a.id) as has_bounced,
          (select rs.reply_providers from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_providers,
          (select rs.reply_campaigns from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_campaigns
        from agents a
        left join (select b.agent_id, string_agg(distinct c.client_name, ', ' order by c.client_name) as cn
                     from v_agent_campaigns b join orch_clients c on c.id = b.client_id
                    where b.agent_id is not null group by b.agent_id) cc on cc.agent_id = a.id
        where %s order by cc.cn %s nulls last, a.sales_volume desc nulls last, a.id limit %s offset %s
      ) t $q$, v_where, case lower(coalesce(p_sort_dir, 'asc')) when 'desc' then 'desc' else 'asc' end, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;

  -- Phase B/C: the page of ids is resolved by fn_agent_page_ids, which sorts a NARROW
  -- (id, sort key) set and joins the 20 survivors back, instead of dragging 1.1M
  -- full-width rows -- every column plus five correlated subqueries -- through the sort.
  -- With a top-bar term it additionally answers the relevance ordering as bounded
  -- per-group queries rather than sorting on a computed expression.
  --
  -- Measured on an unfiltered page: the sort is 540 ms narrow vs ~1,160 ms wide, and drops
  -- to 1.9 ms once the sort column has a matching DESC NULLS LAST index. Row shaping for
  -- the 20 ids is 0.85 ms. What remains is the count+sum aggregate above, ~315 ms.
  --
  -- has_replied deliberately stays on the old path below: it sorts by a computed EXISTS
  -- expression that fn_agent_sort_col has no case for, so routing it here would silently
  -- re-sort the table by sales_volume instead.
  --
  -- This also gives every agent sort the a.id tiebreaker it never had, so pages can no
  -- longer repeat or skip rows where the sort column ties.
  -- has_replied was excluded here because fn_agent_sort_col has no case for it, so routing it
  -- through would have silently re-sorted by sales_volume. fn_agent_page_ids now resolves all
  -- four computed sorts explicitly (Replied / Bounced / Client campaign / Campaigns) from one
  -- shared aggregate, so every sort takes the narrow path. The wide-row query further down is
  -- retained as a fallback but is no longer reached.
  if true then
    v_page := fn_agent_page_ids(p_source, p_filters, p_sort_by, p_sort_dir, p_limit, p_offset);
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select a.*,
          (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
             from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
          (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
             from agent_source_stats s where s.agent_id = a.id) as source_stats,
          (select string_agg(distinct c.client_name, ', ' order by c.client_name)
             from v_agent_campaigns b join orch_clients c on c.id = b.client_id
            where b.agent_id = a.id) as client_campaigns,
          (select count(distinct b5.campaign_id) from v_agent_campaigns b5 where b5.agent_id = a.id) as campaign_count,
          exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
          exists(select 1 from v_bounced_agents b4 where b4.agent_id = a.id) as has_bounced,
          (select rs.reply_providers from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_providers,
          (select rs.reply_campaigns from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_campaigns
        from unnest(%L::uuid[]) with ordinality u(id, ord) join agents a on a.id = u.id
       order by u.ord
      ) t $q$, v_page) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
        (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
           from agent_source_stats s where s.agent_id = a.id) as source_stats,
        (select string_agg(distinct c.client_name, ', ' order by c.client_name)
           from v_agent_campaigns b join orch_clients c on c.id = b.client_id
          where b.agent_id = a.id) as client_campaigns,
        (select count(distinct b5.campaign_id) from v_agent_campaigns b5 where b5.agent_id = a.id) as campaign_count,
        exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
        exists(select 1 from v_bounced_agents b4 where b4.agent_id = a.id) as has_bounced,
          (select rs.reply_providers from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_providers,
          (select rs.reply_campaigns from v_agent_reply_sources rs where rs.agent_id = a.id) as reply_campaigns
      from agents a where %s order by %s limit %s offset %s
    ) t $q$, v_where, v_order, p_limit, p_offset) into v_data;
  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$function$;
