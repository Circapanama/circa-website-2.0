-- =============================================
-- CIRCA PANAMA — SUPABASE SCHEMA
-- =============================================

-- Properties table (central source of truth)
create table properties (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  location text not null default 'Playa Venao',
  category text not null default 'House',
  status text not null default 'Available',
  price numeric,
  price_per_sqm numeric,
  lot_size text,
  construction_size text,
  bedrooms integer,
  bathrooms numeric,
  parking text,
  amenities text,
  owner_developer text,
  owner_contact text,
  image_url text,
  drive_folder_link text,
  legal_docs boolean default false,
  notes text,
  description text,
  -- Project-specific fields
  total_units integer,
  land_size text,
  roi_estimate text,
  market_price_per_sqm text,
  entry_price_per_sqm text,
  eco_features text[],
  community_features text[],
  -- Sync tracking
  sheets_row_index integer,
  last_synced_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Unit types for project-type properties
create table unit_types (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  name text not null,
  bedrooms integer,
  bathrooms numeric,
  indoor_sqm numeric,
  outdoor_sqm numeric,
  price_from numeric,
  price_to numeric,
  created_at timestamptz default now()
);

-- Rental projections
create table rental_projections (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  unit_type text not null,
  occupancy_rate text,
  nightly_rate numeric,
  monthly_rent numeric,
  created_at timestamptz default now()
);

-- Property images (from Drive or uploaded)
create table property_images (
  id uuid default gen_random_uuid() primary key,
  property_id uuid references properties(id) on delete cascade,
  url text not null,
  source text default 'drive',  -- 'drive', 'upload', 'unsplash'
  is_primary boolean default false,
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- Leads (from website bookings + FUB sync)
create table leads (
  id uuid default gen_random_uuid() primary key,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  interest text,
  notes text,
  booking_date text,
  booking_time text,
  source text default 'website',
  fub_lead_id text,
  status text default 'new',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes
create index idx_properties_location on properties(location);
create index idx_properties_category on properties(category);
create index idx_properties_status on properties(status);
create index idx_leads_email on leads(email);
create index idx_leads_status on leads(status);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger properties_updated_at
  before update on properties
  for each row execute function update_updated_at();

create trigger leads_updated_at
  before update on leads
  for each row execute function update_updated_at();

-- Row Level Security
alter table properties enable row level security;
alter table unit_types enable row level security;
alter table rental_projections enable row level security;
alter table property_images enable row level security;
alter table leads enable row level security;

-- Public read for properties (anyone can view listings)
create policy "Public read properties" on properties for select using (true);
create policy "Public read unit_types" on unit_types for select using (true);
create policy "Public read rental_projections" on rental_projections for select using (true);
create policy "Public read property_images" on property_images for select using (true);

-- Service role only for writes (API key from backend)
create policy "Service write properties" on properties for all using (true) with check (true);
create policy "Service write unit_types" on unit_types for all using (true) with check (true);
create policy "Service write rental_projections" on rental_projections for all using (true) with check (true);
create policy "Service write property_images" on property_images for all using (true) with check (true);
create policy "Service write leads" on leads for all using (true) with check (true);
