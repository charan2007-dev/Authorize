// server.js — Express backend for the Attendance Dashboard
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const PORTAL_BASE = process.env.PORTAL_BASE || 'https://samvidha.iare.ac.in';
const ORIGIN = process.env.ORIGIN || 'https://attendancedashboar.vercel.app';

const app = express();
app.set('trust proxy', 1);

// Cross-site cookies between Vercel and Render require credentials + SameSite=None
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 30 * 60 * 1000
  }
}));

/* ------------------------------------------------------------------ */
/* Login counter — in memory, date-keyed, dies on restart              */
/* ------------------------------------------------------------------ */
let counter = { date: today(), count: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
function bumpLogin() {
  if (counter.date !== today()) counter = { date: today(), count: 0 };
  counter.count++;
}

app.get('/today-logins', (req, res) => {
  res.json({ today_logins: counter.date === today() ? counter.count : 0 });
});

/* ------------------------------------------------------------------ */
/* Portal scraping helpers                                            */
/* ------------------------------------------------------------------ */
async function portalLogin(username, password) {
  const jar = axios.create({ baseURL: PORTAL_BASE, withCredentials: true });
  const res = await jar.post('/Login.aspx', new URLSearchParams({
    txtUserName: username,
    txtPassword: password,
    btnLogin: 'Login'
  }));
  const $ = cheerio.load(res.data);
  if ($('#lblError').text().trim()) throw new Error('bad creds');
  return jar;
}

function pct(attended, total) {
  return total ? (attended / total) * 100 : 0;
}

async function scrapeAcademic(jar) {
  const res = await jar.get('/StudentAttendance.aspx');
  const $ = cheerio.load(res.data);
  const rows = [];

  $('table#gvAttendance tr').slice(1).each((_, tr) => {
    const td = $(tr).find('td');
    const attended = Number($(td[2]).text().trim()) || 0;
    const total = Number($(td[3]).text().trim()) || 0;
    if (!total) return;

    const percentage = pct(attended, total);
    rows.push({
      courseCode: $(td[0]).text().trim(),
      subject: $(td[1]).text().trim(),
      attended,
      total,
      percentage,
      classesToAttendFor75: Math.max(0, Math.ceil((0.75 * total - attended) / 0.25)),
      classesCanBunk: Math.max(0, Math.floor((attended - 0.75 * total) / 0.75))
    });
  });

  return rows;
}

async function scrapeBiometric(jar) {
  const res = await jar.get('/BiometricAttendance.aspx');
  const $ = cheerio.load(res.data);
  const totalDays = Number($('#lblTotalDays').text().trim()) || 0;
  const presentCount = Number($('#lblPresentDays').text().trim()) || 0;
  return { totalDays, presentCount, percentage: pct(presentCount, totalDays) };
}

/* ------------------------------------------------------------------ */
/* POST /get-attendance — streamed NDJSON                             */
/* ------------------------------------------------------------------ */
app.post('/get-attendance', async (req, res) => {
  const { username, password } = req.body;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const write = (step, data) => res.write(JSON.stringify({ step, data }) + '\n');

  try {
    const jar = await portalLogin(username, password);

    const academic = await scrapeAcademic(jar);
    if (!academic.length) return res.end();   // client reads this as bad creds

    write('academic', academic);

    const biometric = await scrapeBiometric(jar).catch(() => null);
    if (biometric) write('biometric', biometric);

    write('fetched_at', new Date().toISOString());

    bumpLogin();
    req.session.username = username;

    res.end();
  } catch (err) {
    if (res.headersSent) return res.end();
    res.status(401).json({ error: 'Wrong credentials' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /get-timetable                                                */
/* ------------------------------------------------------------------ */
app.post('/get-timetable', async (req, res) => {
  const { username, password, ay } = req.body;
  try {
    const jar = await portalLogin(username, password);
    const r = await jar.post('/Timetable.aspx', new URLSearchParams({ ddlAcademicYear: ay }));
    const $ = cheerio.load(r.data);

    const weeklyTimetable = [];
    $('table#gvTimetable tr').slice(1).each((_, tr) => {
      const td = $(tr).find('td');
      weeklyTimetable.push({
        day: $(td[0]).text().trim(),
        periods: td.slice(1, 7).map((i, el) => $(el).text().trim()).get()
      });
    });

    const subjects = [];
    $('table#gvSubjects tr').slice(1).each((_, tr) => {
      const td = $(tr).find('td');
      subjects.push({
        sno: $(td[0]).text().trim(),
        subjectCode: $(td[1]).text().trim(),
        shortCode: $(td[2]).text().trim(),
        subjectName: $(td[3]).text().trim(),
        staffName: $(td[4]).text().trim(),
        staffId: $(td[5]).text().trim()
      });
    });

    res.json({
      success: true,
      weeklyTimetable,
      subjects,
      section: $('#lblSection').text().trim(),
      academicYear: ay
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /get-attendance-register                                      */
/* ------------------------------------------------------------------ */
app.post('/get-attendance-register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const jar = await portalLogin(username, password);
    const r = await jar.get('/AttendanceRegister.aspx');
    const $ = cheerio.load(r.data);

    const records = [];
    $('table#gvRegister tr').slice(1).each((_, tr) => {
      const td = $(tr).find('td');
      records.push({
        date: $(td[0]).text().trim(),
        period: $(td[1]).text().trim(),
        subject: $(td[2]).text().trim(),
        status: $(td[3]).text().trim()
      });
    });

    res.json({ success: true, records });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /get-latest — today's periods only                            */
/* ------------------------------------------------------------------ */
app.post('/get-latest', async (req, res) => {
  const { username, password } = req.body;
  try {
    const jar = await portalLogin(username, password);
    const r = await jar.get('/LatestAttendance.aspx');
    const $ = cheerio.load(r.data);

    const latest = [];
    $('table#gvLatest tr').slice(1).each((_, tr) => {
      const td = $(tr).find('td');
      latest.push({
        period: Number($(td[0]).text().trim()),
        status: $(td[1]).text().trim().toUpperCase(),
        subject: $(td[2]).text().trim(),
        date: $(td[3]).text().trim()
      });
    });

    res.json({ success: true, latest });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /logout                                                       */
/* ------------------------------------------------------------------ */
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid', { sameSite: 'none', secure: true });
    res.json({ success: true });
  });
});

app.listen(process.env.PORT || 3000);