-- 0115 (A22 fix) — campaign sends draw a SPREAD SAMPLE, not the top N by sales volume.
--
-- The bug: fn_filter_ids always ordered by sales_volume desc before applying LIMIT/OFFSET,
-- so "send 1,000" from a $0-$5M saved view returned the 1,000 highest producers — measured
-- live, $4,967,679 to $5,000,000 out of a pool of 1,028,150 whose median is $0. The queue
-- shuffle added in A22 only reordered that already-biased slice, which is why every campaign
-- still skewed to top producers however many times it was re-sent.
--
-- The fix: p_sort_by = 'random' orders by md5(id) instead of sales_volume. Two properties
-- matter here, and a plain random() would only give the first:
--   1. the selection spreads across the whole filtered set, at every volume level;
--   2. the order is STABLE, so the send dialog's range control still partitions cleanly —
--      rows 1-1000 and 1001-2000 stay disjoint, and a second batch never re-draws the
--      first batch's agents. With random() each query reshuffles, so sequential batches
--      would silently overlap and re-contact people.
-- md5() over a uuid is uniformly distributed and uncorrelated with sales volume, so this is
-- a real sample, not a re-sorted one.
--
-- Every other p_sort_by value behaves exactly as before; only the new literal 'random' is
-- new behaviour. Export and on-screen sorting are unaffected.

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
declare v_where text; v_order text; v_ids uuid[];
begin
  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
  else
    v_where := fn_agent_where(p_source, p_filters);
  end if;

  if p_sort_by = 'random' then
    -- stable pseudo-random order (see header): spread sample, still range-safe
    v_order := 'md5(a.id::text)';
  elsif p_mode = 'office' then
    v_order := format('%I %s nulls last',
      case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count'
        when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' else 'sales_volume' end,
      case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
  else
    v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);
  end if;

  execute format('select array_agg(id) from (select a.id from %I a where %s order by %s limit %s offset %s) t',
    case when p_mode = 'office' then 'offices' else 'agents' end, v_where, v_order, p_limit, p_offset) into v_ids;
  return coalesce(v_ids, '{}');
end;
$function$;
