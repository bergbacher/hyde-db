-- Tables of example/schema.prisma, as `prisma migrate deploy` would create them, plus one row each.
-- Idempotent: drops what it creates first.
DROP SCHEMA IF EXISTS ai CASCADE;
DROP TABLE IF EXISTS public.orders, public.users, public.api_keys CASCADE;
DROP TYPE IF EXISTS public."Plan";
CREATE TYPE public."Plan" AS ENUM ('FREE', 'PRO');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  country text NOT NULL,
  plan public."Plan" NOT NULL
);
CREATE TABLE public.orders (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users (id),
  total_cents integer NOT NULL,
  placed_at timestamp(3) NOT NULL,
  shipping_address text NOT NULL
);
CREATE TABLE public.api_keys (
  id integer PRIMARY KEY,
  secret text NOT NULL
);
INSERT INTO public.users (email, password_hash, full_name, country, plan)
  VALUES ('ann@example.com', 'x', 'Ann Example', 'DE', 'PRO');
INSERT INTO public.orders (user_id, total_cents, placed_at, shipping_address)
  VALUES (1, 1200, '2026-10-05 12:00:00', 'Example Street 1');
INSERT INTO public.api_keys (id, secret) VALUES (1, 'sk_live_example');
