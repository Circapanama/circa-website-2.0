import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SHEETS_ID = '17nryG-WPTeSxC1n2XiPuRZ1h2CByXUQPlttul35P6Ck';
const DRIVE_FOLDER_ID = '1Wv3-p73s-87aPIaKw0pg8sV6Dbo4uZiX';

// Column mapping (handles variations in Google Sheet headers)
function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP = {
  name: 'name',
  propertyname: 'name',
  location: 'location',
  category: 'category',
  type: 'category',
  status: 'status',
  price: 'price',
  priceusd: 'price',
  pricepersqm: 'price_per_sqm',
  pricesqm: 'price_per_sqm',
  lotsize: 'lot_size',
  lotsizem2: 'lot_size',
  constructionsize: 'construction_size',
  constructionsizem2: 'construction_size',
  bedrooms: 'bedrooms',
  beds: 'bedrooms',
  bathrooms: 'bathrooms',
  baths: 'bathrooms',
  parking: 'parking',
  amenities: 'amenities',
  ownerdeveloper: 'owner_developer',
  owner: 'owner_developer',
  ownercontact: 'owner_contact',
  contact: 'owner_contact',
  imageurl: 'image_url',
  image: 'image_url',
  drivefolderlink: 'drive_folder_link',
  drivefolder: 'drive_folder_link',
  legaldocs: 'legal_docs',
  notes: 'notes',
  description: 'description',
  totalunits: 'total_units',
  landsize: 'land_size',
  roiestimate: 'roi_estimate',
};

async function fetchSheet() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/A1:Z100?key=${process.env.GOOGLE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

async function fetchDriveImages(propertyName) {
  try {
    // Search for a folder matching the property name
    const folderQuery = `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${propertyName.replace(/'/g, "\\'").split(' ')[0]}'`;
    const folderUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(folderQuery)}&key=${process.env.GOOGLE_API_KEY}&fields=files(id,name)`;
    const folderRes = await fetch(folderUrl);
    if (!folderRes.ok) return [];

    const folders = await folderRes.json();
    if (!folders.files?.length) return [];

    // Get images from the folder
    const folderId = folders.files[0].id;
    const imgQuery = `'${folderId}' in parents and mimeType contains 'image/'`;
    const imgUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(imgQuery)}&key=${process.env.GOOGLE_API_KEY}&fields=files(id,name,thumbnailLink)&orderBy=name`;
    const imgRes = await fetch(imgUrl);
    if (!imgRes.ok) return [];

    const images = await imgRes.json();
    return (images.files || []).map((f, i) => ({
      url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w1200`,
      is_primary: i === 0,
      sort_order: i,
      source: 'drive'
    }));
  } catch {
    return [];
  }
}

function parseRow(headers, row) {
  const property = {};
  headers.forEach((header, i) => {
    const key = HEADER_MAP[normalizeHeader(header)];
    if (key && row[i]) {
      let val = row[i].trim();
      if (key === 'price' || key === 'price_per_sqm') {
        val = parseFloat(val.replace(/[^0-9.]/g, '')) || null;
      } else if (key === 'bedrooms' || key === 'total_units') {
        val = parseInt(val) || null;
      } else if (key === 'bathrooms') {
        val = parseFloat(val) || null;
      } else if (key === 'legal_docs') {
        val = val.toLowerCase() === 'yes' || val.toLowerCase() === 'true';
      }
      property[key] = val;
    }
  });
  return property;
}

export default async function handler(req, res) {
  // Allow Vercel cron (sends CRON_SECRET header) or manual trigger with SYNC_SECRET
  const authHeader = req.headers.authorization;
  const cronSecret = req.headers['x-vercel-cron-secret'];
  if (authHeader !== `Bearer ${process.env.SYNC_SECRET}` && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Fetch from Google Sheets
    const rows = await fetchSheet();
    if (rows.length < 2) {
      return res.status(400).json({ error: 'Sheet is empty or has no data rows' });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.length > 0 && r[0]?.trim());

    let synced = 0;
    let errors = [];

    for (let i = 0; i < dataRows.length; i++) {
      try {
        const property = parseRow(headers, dataRows[i]);
        if (!property.name) continue;

        property.sheets_row_index = i + 2; // 1-indexed + header
        property.last_synced_at = new Date().toISOString();

        // Upsert property by name (name is our natural key from Sheets)
        const { data, error } = await supabase
          .from('properties')
          .upsert(property, { onConflict: 'name' })
          .select('id')
          .single();

        if (error) {
          errors.push(`Row ${i + 2} (${property.name}): ${error.message}`);
          continue;
        }

        // Sync Drive images
        const images = await fetchDriveImages(property.name);
        if (images.length > 0) {
          // Clear old drive images and insert new ones
          await supabase
            .from('property_images')
            .delete()
            .eq('property_id', data.id)
            .eq('source', 'drive');

          await supabase
            .from('property_images')
            .insert(images.map(img => ({ ...img, property_id: data.id })));
        }

        synced++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    return res.status(200).json({
      success: true,
      synced,
      total: dataRows.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
