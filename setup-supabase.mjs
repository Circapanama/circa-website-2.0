import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const SCHEMA_PATH = resolve('./supabase-schema.sql');
const schema = readFileSync(SCHEMA_PATH, 'utf-8');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('\n=== CIRCA PANAMA — SUPABASE SETUP ===\n');

  // Step 1: Go to Supabase dashboard
  console.log('1. Opening Supabase dashboard...');
  await page.goto('https://supabase.com/dashboard');

  console.log('   → Please log in if prompted. Waiting for dashboard...\n');

  // Wait for any dashboard page to load (org, projects, or new project)
  await page.waitForURL(/supabase\.com\/dashboard\/(org|project|new|organizations)/, { timeout: 300000 });
  await page.waitForTimeout(3000);
  console.log('2. Logged in!\n');

  const currentUrl = page.url();
  let projectRef = null;

  // Check if we're on org page (no projects yet) or new project page
  if (currentUrl.includes('/new/') || currentUrl.includes('/organizations')) {
    // Check if there are existing projects first
    console.log('   Checking for existing projects...');

    // Navigate to org page to see projects
    const orgMatch = currentUrl.match(/org\/([a-z]+)/);
    const orgId = orgMatch ? orgMatch[1] : null;

    if (orgId) {
      await page.goto(`https://supabase.com/dashboard/org/${orgId}`);
      await page.waitForTimeout(3000);
    }

    // Look for any project link
    const projectLinks = page.locator('a[href*="/project/"]');
    const projectCount = await projectLinks.count();

    if (projectCount > 0) {
      // Check if there's a circa project
      for (let i = 0; i < projectCount; i++) {
        const text = await projectLinks.nth(i).textContent().catch(() => '');
        if (text.toLowerCase().includes('circa')) {
          console.log(`   → Found existing project: ${text.trim()}`);
          await projectLinks.nth(i).click();
          await page.waitForTimeout(3000);
          const ref = page.url().match(/project\/([a-z]+)/);
          if (ref) projectRef = ref[1];
          break;
        }
      }
    }

    if (!projectRef) {
      // Need to create a new project
      console.log('   → Creating new project "circa-panama"...');
      await page.goto(`https://supabase.com/dashboard/new/${orgId || ''}`);
      await page.waitForTimeout(3000);

      // Fill project name
      const nameInput = page.locator('input#project-name, input[name="name"], input[placeholder*="roject"]').first();
      await nameInput.waitFor({ timeout: 10000 });
      await nameInput.fill('circa-panama');
      await page.waitForTimeout(500);

      // Fill database password
      const passInput = page.locator('input[type="password"]').first();
      await passInput.fill('CircaPanama2026!');
      console.log('   → DB password: CircaPanama2026!');
      await page.waitForTimeout(500);

      // Select region - try to find and click US East
      try {
        const regionBtn = page.locator('button, [role="combobox"]').filter({ hasText: /region|select/i }).first();
        const hasRegion = await regionBtn.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasRegion) {
          await regionBtn.click();
          await page.waitForTimeout(1000);
          const usEast = page.locator('[role="option"], li, button').filter({ hasText: /US East|us-east|Virginia/i }).first();
          const hasUsEast = await usEast.isVisible({ timeout: 3000 }).catch(() => false);
          if (hasUsEast) await usEast.click();
          await page.waitForTimeout(500);
        }
      } catch { /* region selection is optional */ }

      // Click "Create new project" button
      const createBtn = page.locator('button').filter({ hasText: /create/i }).last();
      await createBtn.click();
      console.log('   → Creating project (takes ~2 min)...');

      // Wait for redirect to project dashboard
      await page.waitForURL(/\/project\/[a-z]/, { timeout: 300000 });
      await page.waitForTimeout(5000);

      const ref = page.url().match(/project\/([a-z]+)/);
      if (ref) projectRef = ref[1];
      console.log(`   → Project created! Ref: ${projectRef}\n`);
    }
  } else {
    // We're already on a project page
    const ref = currentUrl.match(/project\/([a-z]+)/);
    if (ref) projectRef = ref[1];
  }

  if (!projectRef) {
    console.log('ERROR: Could not determine project reference. Please check the browser.');
    await page.waitForTimeout(300000);
    await browser.close();
    return;
  }

  const supabaseUrl = `https://${projectRef}.supabase.co`;
  console.log(`   Project URL: ${supabaseUrl}`);

  // Step 2: Get API keys
  console.log('\n3. Getting API keys...');
  await page.goto(`https://supabase.com/dashboard/project/${projectRef}/settings/api`);
  await page.waitForTimeout(4000);

  let anonKey = '';
  let serviceKey = '';

  // Get anon key - first code/input element with JWT
  try {
    // Look for the API key values on the page
    const allInputs = page.locator('input, code, [class*="truncate"]');
    const inputCount = await allInputs.count();

    for (let i = 0; i < inputCount; i++) {
      const val = (await allInputs.nth(i).getAttribute('value').catch(() => ''))
              || (await allInputs.nth(i).textContent().catch(() => ''));
      if (val && val.startsWith('eyJ') && val.length > 100) {
        if (!anonKey) {
          anonKey = val.trim();
          console.log(`   → Anon key found: ${anonKey.substring(0, 40)}...`);
        }
      }
    }

    // Click "Reveal" to show service role key
    const revealBtns = page.locator('button').filter({ hasText: /reveal/i });
    const revealCount = await revealBtns.count();
    for (let i = 0; i < revealCount; i++) {
      await revealBtns.nth(i).click();
      await page.waitForTimeout(1500);
    }

    // Scan again for the service key
    const allInputs2 = page.locator('input, code, [class*="truncate"]');
    const inputCount2 = await allInputs2.count();
    for (let i = 0; i < inputCount2; i++) {
      const val = (await allInputs2.nth(i).getAttribute('value').catch(() => ''))
              || (await allInputs2.nth(i).textContent().catch(() => ''));
      if (val && val.startsWith('eyJ') && val.length > 100 && val !== anonKey) {
        serviceKey = val.trim();
        console.log(`   → Service key found: ${serviceKey.substring(0, 40)}...`);
        break;
      }
    }
  } catch (err) {
    console.log(`   → Key extraction error: ${err.message}`);
  }

  // Step 3: Run SQL schema
  console.log('\n4. Running database schema...');
  await page.goto(`https://supabase.com/dashboard/project/${projectRef}/sql/new`);
  await page.waitForTimeout(4000);

  // Click on the editor area
  const monacoEditor = page.locator('.monaco-editor, [class*="editor"]').first();
  await monacoEditor.click();
  await page.waitForTimeout(500);

  // Use clipboard to paste the schema
  await page.evaluate((sql) => {
    // Try Monaco API first
    if (typeof window !== 'undefined') {
      const editors = (window).monaco?.editor?.getEditors?.();
      if (editors?.length) {
        editors[0].setValue(sql);
        return true;
      }
    }
    return false;
  }, schema);

  await page.waitForTimeout(1000);

  // If Monaco API didn't work, try keyboard paste
  const editorContent = await page.evaluate(() => {
    const editors = (window).monaco?.editor?.getEditors?.();
    return editors?.[0]?.getValue?.() || '';
  });

  if (!editorContent.includes('create table')) {
    // Fallback: use clipboard
    await page.evaluate(async (sql) => {
      await navigator.clipboard.writeText(sql);
    }, schema);
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(2000);
  }

  // Click Run (or use Ctrl+Enter)
  const runBtn = page.locator('button').filter({ hasText: /^run$/i }).first();
  const hasRunBtn = await runBtn.isVisible({ timeout: 3000 }).catch(() => false);

  if (hasRunBtn) {
    await runBtn.click();
  } else {
    // Try the run button with icon
    const runBtn2 = page.locator('[aria-label*="run"], button:has(svg)').filter({ hasText: /run/i }).first();
    const hasRunBtn2 = await runBtn2.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasRunBtn2) {
      await runBtn2.click();
    } else {
      await page.keyboard.press('Control+Enter');
    }
  }

  console.log('   → Executing schema...');
  await page.waitForTimeout(8000);

  // Check for success/error indicators
  const pageText = await page.locator('body').textContent();
  if (pageText.includes('Success') || pageText.includes('success')) {
    console.log('   → Schema created successfully!\n');
  } else if (pageText.includes('error') || pageText.includes('ERROR')) {
    console.log('   → There may be errors. Check the browser.\n');
  } else {
    console.log('   → Check the browser for results.\n');
  }

  // Step 4: Save .env files
  console.log('5. Saving credentials...');

  const syncSecret = 'circa-sync-' + Math.random().toString(36).substring(2, 10);
  const cronSecret = 'circa-cron-' + Math.random().toString(36).substring(2, 10);

  // Save .env.local for circa-website-2.0
  const websiteEnv = [
    `SUPABASE_URL=${supabaseUrl}`,
    `SUPABASE_SERVICE_KEY=${serviceKey || 'PASTE_SERVICE_KEY_HERE'}`,
    `SUPABASE_ANON_KEY=${anonKey || 'PASTE_ANON_KEY_HERE'}`,
    `FUB_API_KEY=fka_0KmeKayTlvp4KnLE5C8k2ND8HD8IBio3bF`,
    `GOOGLE_API_KEY=AIzaSyBqt3Y0nqQWvP66lMYtPqkKfyIDwhnJLBc`,
    `GOOGLE_SHEETS_ID=17nryG-WPTeSxC1n2XiPuRZ1h2CByXUQPlttul35P6Ck`,
    `GOOGLE_DRIVE_FOLDER_ID=1Wv3-p73s-87aPIaKw0pg8sV6Dbo4uZiX`,
    `SYNC_SECRET=${syncSecret}`,
    `CRON_SECRET=${cronSecret}`,
  ].join('\n') + '\n';

  writeFileSync(resolve('./.env.local'), websiteEnv);
  console.log('   → Saved circa-website-2.0/.env.local');

  // Update circa-agent-2.0/.env.local
  const agentEnvPath = resolve('../circa-agent-2.0/.env.local');
  try {
    let existingEnv = readFileSync(agentEnvPath, 'utf-8');
    const supaLines = [
      ['SUPABASE_URL', supabaseUrl],
      ['SUPABASE_SERVICE_KEY', serviceKey || 'PASTE_SERVICE_KEY_HERE'],
      ['SUPABASE_ANON_KEY', anonKey || 'PASTE_ANON_KEY_HERE'],
    ];
    for (const [key, val] of supaLines) {
      if (existingEnv.includes(key + '=')) {
        // Replace existing line
        existingEnv = existingEnv.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${val}`);
      } else {
        existingEnv = existingEnv.trimEnd() + `\n${key}=${val}`;
      }
    }
    writeFileSync(agentEnvPath, existingEnv + '\n');
    console.log('   → Updated circa-agent-2.0/.env.local');
  } catch {
    console.log('   → Could not update circa-agent-2.0/.env.local (do it manually)');
  }

  console.log('\n=== SETUP COMPLETE ===\n');
  console.log(`Project ref:  ${projectRef}`);
  console.log(`URL:          ${supabaseUrl}`);
  console.log(`Anon key:     ${anonKey ? 'Found' : 'COPY MANUALLY from API settings'}`);
  console.log(`Service key:  ${serviceKey ? 'Found' : 'COPY MANUALLY from API settings'}`);
  console.log(`Sync secret:  ${syncSecret}`);
  console.log(`Cron secret:  ${cronSecret}`);
  console.log('\nBrowser staying open — verify everything looks good, then press Ctrl+C.\n');

  // Keep browser open
  await page.waitForTimeout(600000);
  await browser.close();
})();
