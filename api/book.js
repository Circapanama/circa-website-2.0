export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firstName, lastName, email, phone, interest, notes, date, time } = req.body;

  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
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
    const fubHeaders = {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + authToken
    };

    const interestTag = interestLabels[interest] || 'General Inquiry';
    const noteBody = [
      `BOOKING REQUEST`,
      `Date: ${date}`,
      `Time: ${time}`,
      `Interest: ${interestTag}`,
      notes ? `Notes: ${notes}` : null
    ].filter(Boolean).join('\n');

    tasks.push(
      // Create the lead via Events API
      fetch('https://api.followupboss.com/v1/events', {
        method: 'POST',
        headers: fubHeaders,
        body: JSON.stringify({
          source: 'Circa Panama Website',
          system: 'CircaPanama',
          type: 'Registration',
          description: noteBody,
          message: noteBody,
          person: {
            firstName,
            lastName,
            emails: [{ value: email }],
            phones: phone ? [{ value: phone }] : [],
            tags: ['Website Booking', 'Playa Venao', interestTag]
          },
          property: {
            street: 'Playa Venao',
            city: 'Pedasi',
            state: 'Los Santos',
            country: 'Panama'
          }
        })
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`FUB event ${r.status}: ${body}`);
        }
        const eventData = await r.json();

        // Add a note to the person so the booking details show in their timeline
        if (eventData.id) {
          // Look up the person by email to get their ID
          const searchRes = await fetch('https://api.followupboss.com/v1/people?q=' + encodeURIComponent(email), {
            headers: fubHeaders
          });
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            if (searchData.people && searchData.people.length > 0) {
              const personId = searchData.people[0].id;
              await fetch('https://api.followupboss.com/v1/notes', {
                method: 'POST',
                headers: fubHeaders,
                body: JSON.stringify({
                  personId,
                  subject: 'Website Booking Request',
                  body: noteBody
                })
              });
            }
          }
        }

        return eventData;
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
