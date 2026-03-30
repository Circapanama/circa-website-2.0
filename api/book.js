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

  const tasks = [];

  // 1. Save to Supabase (only if configured)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    tasks.push(
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
      })
    );
  }

  // 2. Create lead in Follow Up Boss (only if configured)
  if (process.env.FUB_API_KEY) {
    const authToken = Buffer.from(process.env.FUB_API_KEY + ':').toString('base64');
    tasks.push(
      fetch('https://api.followupboss.com/v1/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + authToken
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
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`FUB ${r.status}: ${body}`);
        }
        return r.json();
      })
    );
  }

  const results = await Promise.allSettled(tasks);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Task ${i} error:`, r.reason);
    }
  });

  return res.status(200).json({ success: true });
}
