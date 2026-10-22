-- 0126 — "Office Agent Count" filter for the Agent view.
--
-- Shows only agents whose office has the selected number of agents. One predicate in
-- fn_agent_where, so every agent-level consumer agrees automatically: the search count and page,
-- CSV export and campaign-send ids, the MLS-in-set list, typeahead facets, saved-view
-- include/exclude, and saved-view counts.
--
-- Base: the LIVE definition (pg_get_functiondef, md5 0ff7e444b9c73241cc7da8250f7f1bf9 —
-- byte-identical to 0109:35-500) plus the one block marked 0126. Signature unchanged, so grants
-- carry over. Inert until the client sends officeAgentCount, so it ships BEFORE the UI.
-- Rollback: re-run the 0109 definition of fn_agent_where.

CREATE OR REPLACE FUNCTION public.fn_agent_where(p_source text, p_filters jsonb, p_alias text DEFAULT 'a'::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; vconds text[]; side text; c text; v text; vst text; vbase text;
  citycol text; statecol text; ccol text;
  v_client_ids text[];
  -- Alias of the agents relation this predicate gets pasted into. Most callers scan
  -- "from agents a"; the saved-view blocks nest a second agents scan aliased a9. Emissions that
  -- have to name the outer row (the saved-view references below, and the location exclude) use
  -- this instead of assuming 'a'. quote_ident keeps it out of injection range.
  v_alias text := quote_ident(coalesce(nullif(p_alias, ''), 'a'));
  view_id text; vv jsonb; vmode text; vsrc text; vwhere text;
  sel_mls uuid[]; scoped boolean := false; hconds text[] := '{}'; hc text;
  grp record;
begin
  -- A5 phase 3: MLS-scoped production filtering. Active only when EVERY selected MLS has
  -- near-complete per-MLS stats coverage (>= 90% of members) — until the 15-day refresh
  -- fills agent_mls_stats, behavior stays exactly as before.
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) > 0 then
    sel_mls := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
    select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
      into scoped from mls where id = any(sel_mls);
    scoped := coalesce(scoped, false);
  end if;
  if p_source = 'zillow_realtor' then
    parts := parts || format('sources && %L::text[]', array['zillow', 'realtor']);
  elsif p_source = 'courted' then
    parts := parts || format('sources && %L::text[]', array['courted']);
  end if;

  v_client_ids := case
    when jsonb_typeof(p_filters->'orchClientIds') = 'array' and jsonb_array_length(p_filters->'orchClientIds') > 0
      then array(select jsonb_array_elements_text(p_filters->'orchClientIds'))
    when coalesce(p_filters->>'orchClientId', '') <> ''
      then array[p_filters->>'orchClientId']
    else null end;
  if v_client_ids is not null then
    if coalesce(p_filters->>'orchClientMode', 'include') = 'exclude' then
      parts := parts || format('id not in (select b.agent_id from v_agent_campaigns b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from v_agent_campaigns x where x.client_id = l.client_id))', v_client_ids);
    else
      parts := parts || format('id in (select b.agent_id from v_agent_campaigns b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from v_agent_campaigns x where x.client_id = l.client_id))', v_client_ids);
    end if;
  end if;

  -- LOCATION (A14: values = include, excludeValues = exclude). Exclude wraps in
  -- not coalesce(cond, false) so agents with NULL location columns are KEPT — "not in Miami"
  -- must not drop agents whose location is simply unknown.
  f := p_filters->'location';
  if f is not null then
    field := coalesce(f->>'field', 'city');
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    foreach side in array array['values', 'excludeValues'] loop
        field := case when side = 'excludeValues' then coalesce(nullif(f->>'excludeField', ''), f->>'field') else f->>'field' end; -- D3: exclude may target a different geography level
      if jsonb_typeof(f->side) = 'array' and jsonb_array_length(f->side) > 0 then
        kconds := '{}';
        -- values may MIX geography levels: plain strings use the side's field; objects
        -- {"f": "county", "v": "Bucks, PA"} carry their own. Each level's group builds its
        -- own condition; the side OR's them together (include) / excludes them all.
        for grp in
          select coalesce(case when jsonb_typeof(e.value) = 'object' then nullif(e.value->>'f', '') end, field) as ef,
                 jsonb_agg(case when jsonb_typeof(e.value) = 'object' then e.value->>'v' else e.value #>> '{}' end) as vals
            from jsonb_array_elements(f->side) e
           group by 1
        loop
        foreach kind in array kinds loop
          citycol := case kind when 'office' then 'office_city' when 'home' then 'home_city' when 'transacted' then 'most_transacted_city' else null end;
          statecol := case kind when 'office' then 'office_state' when 'home' then 'home_state' when 'transacted' then 'transacted_state' else null end;
          ccol := case kind when 'office' then 'office_county' when 'home' then 'home_county' when 'transacted' then 'most_transacted_county' else null end;
          if citycol is null then continue; end if;

          if grp.ef = 'city' or grp.ef = 'county' then
            -- keys are computed HERE (once) and matched via = ANY(array): one match-key
            -- evaluation per row per kind, index-friendly. The old per-value OR chain
            -- evaluated the regex key per VALUE per row — a 40-city saved view was ~93M
            -- regex calls and blew the API statement timeout (rendered as "0 agents").
            vconds := '{}';
            arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end
                         from jsonb_array_elements_text(grp.vals) x(v)
                         where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is null
                           and (case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end) is not null);
            if array_length(arr, 1) > 0 then
              if grp.ef = 'city' then
                vconds := vconds || format('%I = ANY(%L::text[])', citycol || '_key', arr);
              else
                vconds := vconds || format('lower(%I) = ANY(%L::text[])', ccol, arr);
              end if;
            end if;
            for vst in select distinct upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1])
                       from jsonb_array_elements_text(grp.vals) x(v)
                       where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is not null loop
              arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) else lower(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) end
                           from jsonb_array_elements_text(grp.vals) x(v)
                           where upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1]) = vst);
              arr := array(select y from unnest(arr) y where y is not null);
              if array_length(arr, 1) > 0 then
                if grp.ef = 'city' then
                  vconds := vconds || format('(%I = ANY(%L::text[]) and coalesce(upper(%I), fn_city_embedded_state(%I)) = %L)', citycol || '_key', arr, statecol, citycol, vst);
                else
                  vconds := vconds || format('(lower(%I) = ANY(%L::text[]) and upper(%I) = %L)', ccol, arr, statecol, vst);
                end if;
              end if;
            end loop;
            if array_length(vconds, 1) > 0 then kconds := kconds || ('(' || array_to_string(vconds, ' or ') || ')'); end if;
          else
            arr := array(select jsonb_array_elements_text(grp.vals));
            col := case grp.ef
              when 'zip' then case kind when 'office' then 'office_zip' when 'home' then 'home_zip' else 'most_transacted_zip' end
              when 'state' then statecol
              else null end;
            if grp.ef = 'state' and col is not null then
              kconds := kconds || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
            elsif col is not null then
              kconds := kconds || format('%I = ANY(%L::text[])', col, arr);
            end if;
          end if;
        end loop;
        end loop;
        if array_length(kconds, 1) > 0 then
          if side = 'excludeValues' then
            -- Excluding places emitted "not coalesce((<or of column tests>), false)". Nothing
            -- about that is indexable, so Postgres read all 1.13M agents and deformed each wide
            -- row to reach up to nine location columns. Excluding 7 cities measured 6,379 ms in
            -- the count alone, against 260 ms to INCLUDE the same 7; the 20-row page was 0.46 ms,
            -- so effectively the whole cost was the count.
            --
            -- Asked the other way round -- find the agents that DO match, via the indexes that
            -- already exist, and keep everyone else -- it plans as a hash anti-join.
            --
            -- NOT EXISTS specifically, not NOT IN. An earlier attempt used "id not in (select
            -- ...)", which is alias-free and looks equivalent. It is not: NOT IN cannot always
            -- become an anti-join because of its NULL rules, and when the planner's estimate
            -- exceeds work_mem it silently falls back to a per-row subplan. City excludes went
            -- 6,132 -> 1,061 ms, but excluding two states went 1,797 ms -> over ten minutes.
            -- NOT EXISTS is a true anti-join and has no such cliff.
            --
            -- The price is that NOT EXISTS must name the outer row, hence v_alias. Get that
            -- wrong and the subquery compares a row to itself and matches everything, so the
            -- alias is threaded explicitly through every nested call rather than assumed.
            parts := parts || format('not exists (select 1 from agents axl where axl.id = %s.id and (%s))',
                                     v_alias, array_to_string(kconds, ' or '));
          else
            parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
          end if;
        end if;
      end if;
    end loop;
  end if;

  f := p_filters->'salesVolume';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_dollar)' when 'buy' then 'sum(buy_side_dollar)' else 'sum(sales_volume)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_dollar' when 'buy' then 'buy_side_dollar' else 'sales_volume' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'closedUnits';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_count)' when 'buy' then 'sum(buy_side_count)' else 'sum(units)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'units' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'closedTransactions';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_count)' when 'buy' then 'sum(buy_side_count)' else 'sum(closed_transactions)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'closed_transactions' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'estTimeInIndustry';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_in_industry_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'approxGci';
  if f is not null then
    if scoped then
      hc := fn_range_cond_expr('sum(approx_gci)', f); if hc is not null then hconds := hconds || hc; end if;
    else
      c := fn_range_cond('approx_gci', f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'avgSalePrice';
  if f is not null then
    if scoped then
      hc := fn_range_cond_expr('(sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / nullif(sum(units), 0))', f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      c := fn_range_cond('avg_sale_price', f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'estTimeInOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'avgTimeAtOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('avg_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'officeSearch';
  if f is not null then
    sub := f->'brand';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('brand = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(brand is null or brand <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
    sub := f->'office';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('office_name = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(office_name is null or office_name <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
  end if;

  f := p_filters->'mls';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('id in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('id not in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;


  -- A5: agents affiliated with 2+ MLSs
  if coalesce(p_filters->>'multiMls', '') = 'true' then
    parts := parts || 'mls_count >= 2'::text;
  end if;

  -- Agents present in more than one campaign. Unlike multiMls there is no maintained counter
  -- column to lean on (mls_count is one), so this groups v_agent_campaigns -- both providers,
  -- idx_bcl_agent, measured 203 ms. A lead can sit in several campaigns of the SAME client, and
  -- that still counts: the question is how many campaigns the agent is in, not how many clients.
  if coalesce(p_filters->>'multiCampaign', '') = 'true' then
    parts := parts || 'id in (select agent_id from v_agent_campaigns where agent_id is not null group by agent_id having count(distinct campaign_id) >= 2)'::text;
  end if;

  -- B3: exact MLS-affiliation-count buckets ('2','3','4','5' exact, '6+' open-ended),
  -- OR'd together, over the trigger-maintained agents.mls_count column.
  f := p_filters->'mlsCount';
  if f is not null and jsonb_array_length(coalesce(f->'buckets', '[]'::jsonb)) > 0 then
    kconds := '{}';
    for kind in select jsonb_array_elements_text(f->'buckets') loop
      if kind = '6+' then
        kconds := kconds || 'mls_count >= 6'::text;
      elsif kind ~ '^[0-9]+$' then
        kconds := kconds || format('mls_count = %s', kind::int);
      end if;
    end loop;
    if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
  end if;

  -- A12: saved views as LIVE include/exclude sets. Each referenced view resolves to its
  -- current membership (its own stored filters, source and mode) via correlated EXISTS
  -- anti-joins (NOT IN over 770k ids planned as an O(n^2) null-aware subplan and timed out).
  -- Requires the outer agents relation to be aliased "a" (fn_filter_search / fn_filter_ids).
  -- INCLUDE = agent in ANY selected view (union — multiple lead lists compose additively);
  -- EXCLUDE = agent in NONE of the selected views. A referenced view's own nested saved-view
  -- refs are stripped (depth 1 -> cycles impossible); broken/deleted views are skipped.
  f := p_filters->'savedViews';
  if f is not null then
    for side in select unnest(array['include', 'exclude']) loop
      kconds := '{}';
      if jsonb_typeof(f->side) = 'array' then
        for view_id in select jsonb_array_elements_text(f->side) loop
          begin
            select filters, coalesce(mode, 'agent'), coalesce(source_mode, 'courted')
              into vv, vmode, vsrc from saved_lists where id = view_id::uuid;
            if vv is not null then
              vv := vv - 'savedViews';
              if vmode = 'office' then
                kconds := kconds || format('%s.office_id in (select o9.id from offices o9 where (%s))', v_alias, fn_office_where(vv));
              elsif side = 'include' then
                -- INCLUDE inlines: the view's conditions reference bare agents columns, so they
                -- apply straight to the outer relation -- one indexed scan instead of a subquery
                -- returning up to 1.1M ids. Measured 4.7 s -> 1.1 s for two views.
                kconds := kconds || format('(%s)', fn_agent_where(vsrc, vv, p_alias));
              else
                -- EXCLUDE keeps the subquery. Negation cannot use an index, so an inlined
                -- "not (...)" degrades to a full scan evaluating every condition per row:
                -- 6.6 s inlined vs 1.5 s as a hashed anti-join, same 1,100,594 rows. The
                -- subquery form also carries the right NULL semantics for free -- an agent the
                -- view does not return is simply not IN it, so excluding the view keeps them.
                kconds := kconds || format('%s.id in (select a9.id from agents a9 where (%s))', v_alias, fn_agent_where(vsrc, vv, 'a9'));
              end if;
            end if;
          exception when others then
            null; -- deleted id / malformed stored filters: skip this view, keep the search alive
          end;
        end loop;
      end if;
      if array_length(kconds, 1) > 0 then
        if side = 'exclude' then
          parts := parts || ('not (' || array_to_string(kconds, ' or ') || ')');
        else
          parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
        end if;
      end if;
    end loop;
  end if;

  f := p_filters->'title';
  if f is not null then
    -- title may hold multiple titles separated by comma or slash (e.g. 'Salesperson, Team Leader').
    -- Match per token, ignoring case/spacing/punctuation ('sales person' == 'Salesperson').
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format(
        'fn_title_tokens(title) && %L::text[]',
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'include') x(v)));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      -- Same shape as the location exclude: "not (tokens && array)" is a NOT over a GIN index,
      -- which no index can serve, so it scanned all 1.13M agents and called fn_title_tokens on
      -- every row -- 3,238 ms for the count, the worst single filter in a 325-combination sweep,
      -- and it poisoned every pair it appeared in (up to 10,934 ms). Asked as an anti-join over
      -- the POSITIVE form it rides idx_agents_title_tokens instead.
      --
      -- Semantics unchanged: the old form kept a row when the title was NULL or no token
      -- overlapped; NOT EXISTS keeps a row when the positive is not true -- the same two cases,
      -- since a NULL title cannot overlap. v_alias is threaded for the same reason as the
      -- location exclude: the saved-view blocks nest a second agents scan aliased a9.
      parts := parts || format(
        'not exists (select 1 from agents axt where axt.id = %s.id and fn_title_tokens(axt.title) && %L::text[])',
        v_alias,
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'exclude') x(v)));
    end if;
  end if;

  f := p_filters->'license';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('license_number = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(license_number is null or license_number <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  f := p_filters->'name';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'include') loop
        kconds := kconds || format('full_name ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'exclude') loop
        kconds := kconds || format('full_name not ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(full_name is null or (' || array_to_string(kconds, ' and ') || '))'); end if;
    end if;
  end if;

  f := p_filters->'zillowRealtor';
  if f is not null then
    if jsonb_array_length(coalesce(f->'languages', '[]'::jsonb)) > 0 then
      -- The unnest + lower() form could not use idx_agents_languages, so this scanned the whole
      -- table: 3,001 ms, against 0.98 ms for the indexable "languages && '{Spanish}'". Matching
      -- stays case-insensitive -- fn_lower_arr lowercases the stored array and has its own GIN
      -- index -- so a value stored as "spanish" still matches a search for "Spanish".
      parts := parts || format('fn_lower_arr(languages) && %L::text[]',
        array(select lower(jsonb_array_elements_text(f->'languages'))));
    end if;
    c := fn_range_cond('total_sales_all_time', f->'totalSales'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_price_all_time', f->'avgPriceAllTime'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_sales_volume_all_time', f->'avgVolumeAllTime'); if c is not null then parts := parts || c; end if;
    if (f->>'hasLinkedin') = 'true' then parts := parts || 'linkedin_url is not null'::text; end if;
  end if;

  -- A3: contact has/missing (email presence counts preferred OR enriched)
  f := p_filters->'contact';
  if f is not null then
    if f->>'email' = 'has' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is not null'::text;
    elsif f->>'email' = 'missing' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text;
    end if;
    if f->>'phone' = 'has' then
      parts := parts || '(preferred_phone is not null and preferred_phone <> '''')'::text;
    elsif f->>'phone' = 'missing' then
      parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text;
    end if;
    -- C2: been through enrichment and holds a verified email
    if f->>'enriched' = 'has' then
      parts := parts || '(enriched_at is not null and enriched_email is not null)'::text;
    elsif f->>'enriched' = 'missing' then
      parts := parts || '(enriched_at is null or enriched_email is null)'::text;
    end if;
    -- C4: has this lead EVER replied to us, in EITHER provider. The view unions the Bison flag
    -- with the Instantly reply mirror, so a third provider later changes only that one object.
    -- It filters agent_id is not null, which the 'missing' branch depends on: a single NULL
    -- inside a NOT IN makes the whole predicate return zero rows.
    if f->>'replied' = 'has' then
      parts := parts || 'id in (select agent_id from v_replied_agents)'::text;
    elsif f->>'replied' = 'missing' then
      parts := parts || 'id not in (select agent_id from v_replied_agents)'::text;
    end if;
    -- C1: the lead's emails BOUNCED (flag maintained by the 6-hourly Bison sync)
    if f->>'bounced' = 'has' then
      parts := parts || 'id in (select agent_id from v_bounced_agents)'::text;
    elsif f->>'bounced' = 'missing' then
      parts := parts || 'id not in (select agent_id from v_bounced_agents)'::text;
    end if;
    -- C5: already sitting in a client's Bison campaign
    if f->>'inCampaign' = 'has' then
      parts := parts || 'id in (select agent_id from v_campaign_agents)'::text;
    elsif f->>'inCampaign' = 'missing' then
      parts := parts || 'id not in (select agent_id from v_campaign_agents)'::text;
    end if;
  end if;

  -- legacy missingContact (old saved views)
  f := p_filters->'missingContact';
  if f is not null then
    if (f->>'email') = 'true' then parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text; end if;
    if (f->>'phone') = 'true' then parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text; end if;
  end if;

  -- 0126: Agent view's "Office Agent Count" — agents whose OFFICE has the selected headcount,
  -- ranging on offices.agent_count (the number the Office view shows in its Agents column).
  -- A dedicated key, NOT agentCount: that key already means office headcount (Office view),
  -- brand total (Brand) and place/MLS total (Location/MLS), and Location/MLS pass their full
  -- payload into this function — reading agentCount here double-applied it in the wrong units
  -- (MLS '10K+': 35 rows -> 0 in a rolled-back test). The client sends this key from the Agent
  -- view only. An empty range emits nothing (fn_range_cond returns null), so the Location/MLS
  -- caches and the facet shortcut are untouched. Placed after the saved-view block: on a view
  -- spanning every MLS this order probed offices ~540 times instead of ~44k (1.6s -> 0.6s).
  -- Agents with no office never match while the filter is active — there is no size to compare.
  f := p_filters->'officeAgentCount';
  if f is not null then
    c := fn_range_cond('agent_count', f);
    if c is not null then
      parts := parts || format('%s.office_id in (select oac.id from offices oac where %s)', v_alias, c);
    end if;
  end if;

  if scoped and array_length(hconds, 1) > 0 then
    parts := parts || format('id in (select agent_id from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id having %s)',
                             sel_mls, array_to_string(hconds, ' and '));
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$function$;
