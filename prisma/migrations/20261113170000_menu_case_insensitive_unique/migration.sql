-- Stop safely and report every conflicting ID; never merge or delete dishes.
DO $$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(format('restaurant=%s name=%s ids=%s', restaurant_id, normalized, ids), '; ')
  INTO conflicts
  FROM (
    SELECT restaurant_id, lower(btrim(name)) AS normalized, string_agg(id, ',' ORDER BY id) AS ids
    FROM menus GROUP BY restaurant_id, lower(btrim(name)) HAVING count(*) > 1
  ) duplicates;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Menu group duplicate preflight failed: %', conflicts;
  END IF;
END $$;
CREATE UNIQUE INDEX "menus_restaurant_name_ci" ON "menus" ("restaurant_id", lower(btrim("name")));
