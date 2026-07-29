/* Supabase layer */

const SUPABASE_URL = 'https://wipjgcydeimjprmfiwvq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpcGpnY3lkZWltanBybWZpd3ZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNTE0MzEsImV4cCI6MjEwMDkyNzQzMX0.Qfi4siVns2IVjfQHM52InwDZoE4lncbrwQu8FkhH-1I';

window.TalkHub = window.TalkHub || {};
const TH = window.TalkHub;

TH.waitForSupabase = function(ms = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof window.supabase !== 'undefined' && window.supabase?.createClient) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (typeof window.supabase !== 'undefined' && window.supabase?.createClient) {
        clearInterval(check); resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(check); reject(new Error('Supabase SDK не загрузился'));
      }
    }, 50);
  });
};

TH.initSupabase = async function() {
  if (TH._supabase) return;
  await TH.waitForSupabase();
  TH._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
};

TH.getDb = function() { return TH._supabase; };
