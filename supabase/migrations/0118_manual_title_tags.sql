-- 0118 (A5) — tag an agent as Team Leader / Managing Broker by hand, and have it survive.
--
-- agents.title is 100% derived at ingest from the Courted columns "Is Managing Broker" /
-- "Is Team Leader", falling back to the literal "Salesperson". Today's distribution over
-- 1,167,174 agents: Salesperson 1,022,568 (87.6%), Managing Broker 123,914, Team Leader 18,724,
-- "Managing Broker, Team Leader" 1,971. Roughly 70k courted agents have no role columns in their
-- feed at all, so their "Salesperson" is a fallback rather than a fact — hence this request.
--
-- THE TRAP: writing a tag straight into agents.title would be erased within days. In the ingest
-- UPDATE, title is in none of SOURCE_ONLY_COLS / MERGE_FILL_COLS / METRIC_COLS, so it falls
-- through to the unconditional `title = x.title`. Sweeps are heavy (157,307 agents updated on
-- 2026-08-26 alone), so a manual tag would silently vanish.
--
-- STORAGE: source_ids -> 'manual' -> 'titles', a jsonb array. Ingest provably cannot touch it —
-- it only ever replaces the key named by the CURRENT source (`source_ids || jsonb_build_object
-- ($2, x.courted)`), and no source is ever called 'manual'. No DDL, no new column, no new index.
--
-- Deliberately NOT stored in 'agent_provided': the profile save route REPLACES that whole object
-- on every contact edit and deletes it outright when both contact fields are cleared, so a
-- titles key there would be destroyed the next time someone edited a phone number.
--
-- PROJECTION: agents.title stays the single effective value, so every existing read path — the
-- title filter, fn_title_tokens, the GIN index, fn_search_options, the table column — keeps
-- working with zero changes. The combined form "Managing Broker, Team Leader" already exists on
-- 1,971 production rows and is already understood end to end.

-- Union of derived + manual roles, in a fixed canonical order. Idempotent: re-applying its own
-- output changes nothing. "Salesperson" is dropped as soon as any real role is present, matching
-- the existing combined value, which carries no Salesperson token.
create or replace function public.fn_effective_title(p_derived text, p_manual jsonb)
returns text
language sql
immutable parallel safe
set search_path to 'public'
as $$
  with roles as (
    select r, ord from (values ('Managing Broker', 1), ('Team Leader', 2)) as v(r, ord)
  ),
  derived as (select fn_title_tokens(coalesce(p_derived, '')) as toks),
  manual as (
    select coalesce(array_agg(regexp_replace(lower(t), '[^a-z0-9]', '', 'g')), '{}'::text[]) as toks
      from jsonb_array_elements_text(case when jsonb_typeof(p_manual) = 'array' then p_manual else '[]'::jsonb end) t
  ),
  kept as (
    select roles.r, roles.ord
      from roles, derived, manual
     where regexp_replace(lower(roles.r), '[^a-z0-9]', '', 'g') = any(derived.toks)
        or regexp_replace(lower(roles.r), '[^a-z0-9]', '', 'g') = any(manual.toks)
     order by roles.ord
  )
  select coalesce(nullif((select string_agg(r, ', ' order by ord) from kept), ''), 'Salesperson');
$$;

-- Set or clear an agent's manual role tags. Passing an empty array removes the 'manual' key
-- entirely, which restores the purely derived title on the next sweep.
-- Returns the agent's new effective title.
create or replace function public.fn_set_manual_titles(
  p_agent_id uuid, p_titles text[], p_actor text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_clean text[]; v_title text; v_derived text;
begin
  -- only the two real roles are storable; anything else is ignored rather than trusted
  v_clean := array(select distinct r from unnest(coalesce(p_titles, '{}'::text[])) r
                    where r in ('Managing Broker', 'Team Leader'));

  if array_length(v_clean, 1) is null then
    update agents set source_ids = coalesce(source_ids, '{}'::jsonb) - 'manual', updated_at = now()
     where id = p_agent_id;
  else
    update agents set source_ids = coalesce(source_ids, '{}'::jsonb) || jsonb_build_object(
             'manual', jsonb_build_object(
               'titles', to_jsonb(v_clean),
               'set_by', p_actor,
               'set_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'))),
           updated_at = now()
     where id = p_agent_id;
  end if;

  -- Re-project title immediately so the change shows without waiting for a sweep. The derived
  -- half is recovered from the courted feed flags, so clearing a tag restores the true value
  -- rather than stranding whatever the tag had produced.
  -- Both flags can be true at once (1,798 agents today), so build the derived half from BOTH
  -- rather than the either/or the old deriveTitle used — that either/or is what left those rows
  -- one sweep away from silently losing their Team Leader half.
  select coalesce(nullif(concat_ws(', ',
           case when coalesce((source_ids->'courted'->>'is_managing_broker')::boolean, false) then 'Managing Broker' end,
           case when coalesce((source_ids->'courted'->>'is_team_leader')::boolean, false) then 'Team Leader' end), ''), 'Salesperson')
    into v_derived
    from agents where id = p_agent_id;

  update agents a set title = fn_effective_title(v_derived, a.source_ids->'manual'->'titles')
   where a.id = p_agent_id
   returning a.title into v_title;

  return v_title;
end;
$$;
