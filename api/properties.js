import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { location, category, status } = req.query;

  try {
    let query = supabase
      .from('properties')
      .select(`
        *,
        unit_types (*),
        rental_projections (*),
        property_images (*)
      `)
      .order('name');

    if (location) query = query.eq('location', location);
    if (category) query = query.eq('category', category);
    if (status) query = query.eq('status', status || 'Available');

    const { data, error } = await query;

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Failed to fetch properties' });
    }

    return res.status(200).json({ properties: data, source: 'supabase' });
  } catch (err) {
    console.error('Properties error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
