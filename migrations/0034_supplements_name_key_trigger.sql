-- 0034_supplements_name_key_trigger.sql
-- Automatically populate name_key on supplements BEFORE INSERT OR UPDATE if missing.

CREATE OR REPLACE FUNCTION set_supplements_name_key() RETURNS trigger AS $$
BEGIN
  IF NEW.name_key IS NULL OR NEW.name_key = '' THEN
    NEW.name_key = lower(NEW.name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplements_set_name_key ON supplements;
CREATE TRIGGER supplements_set_name_key BEFORE INSERT OR UPDATE ON supplements
  FOR EACH ROW EXECUTE FUNCTION set_supplements_name_key();
