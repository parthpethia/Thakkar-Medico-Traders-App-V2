-- Thakkar Medico — V41: Drop stale place_order overloads
-- 
-- Previous migrations created place_order with different number of parameters (4, 5, 7, and 8).
-- Leaving old overloads in the database causes resolution ambiguity when functions are called with few arguments.
-- This migration drops the obsolete overloads, leaving only the latest 8-argument version.

DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid);
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text);
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text, integer, text);
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text, int, text);

