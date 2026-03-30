import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firstName, lastName, email, phone, interest, notes, date, time } = req.body;

  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const interestLabels = {
    buying: 'Buying Property',
    selling: 'Selling Property',
    investing: 'Investment Opportunities',
    relocating: 'Relocating to Panama',
    other: 'Something Else'
  };

  // Save to Supabase and FUB in parallel
  const [supaResult, fubResult] = await Promise.allSettled([
    // 1. Save to Supabase
    supabase.from('leads').insert({
      first_name: firstName,
      last_name: lastName,
      email,
      phone: phone || null,
      interest: interestLabels[interest] || interest || null,
      notes: notes || null,
      booking_date: date,
      booking_time: time,
      source: 'website'
    }),

    // 2. Create lead in Follow Up Boss
    fetch('https://api.followupboss.com/v1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(process.env.FUB_API_KEY + ':')
      },
      body: JSON.stringify({
        source: 'Circa Panama Website',
        system: 'CircaPanama',
        type: 'Registration',
        message: `New booking request for ${date} at ${time}.\nInterest: ${interestLabels[interest] || interest || 'Not specified'}\nNotes: ${notes || 'None'}`,
        person: {
          firstName,
          lastName,
          emails: [{ value: email }],
          phones: phone ? [{ value: phone }] : [],
          tags: ['Website Booking', 'Playa Venao']
        }
      })
    })
  ]);

  // Log errors but don't fail the request
  if (supaResult.status === 'rejected') {
    console.error('Supabase error:', supaResult.reason);
  }
  if (fubResult.status === 'rejected') {
    console.error('FUB error:', fubResult.reason);
  }

  return res.status(200).json({ success: true });
}
