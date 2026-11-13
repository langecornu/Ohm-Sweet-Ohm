// Dev-only helper: renders the daily email report to /tmp for visual
// inspection, using real local data and the real channel config. Not part
// of the app itself — just a repeatable way to preview template changes
// without waiting for the actual midnight trigger or re-typing this by
// hand every time.
//   node scripts/preview-daily-email.js [YYYY-MM-DD]
import fs from "node:fs";
import * as dailyEmail from "../src/dailyEmail.js";
import * as weather from "../src/weather.js";
import * as tz from "../src/tz.js";
import { getChannelList } from "../src/channelConfig.js";

const channels = getChannelList();
const channelKinds = channels.map((c) => c.kind);
const channelLabels = channels.map((c) => c.label);
const timezone = weather.getConfiguredTimezone();
const location = weather.getWeatherLocation();

const todayStr = tz.localDateStr(Date.now(), timezone);
const ds = process.argv[2] || dailyEmail.dayBeforeStr(todayStr);

// Reuse the exact same data-gathering path the real send uses, so this
// preview can never drift out of sync with what actually ships.
const data = await dailyEmail.gatherReportData({ ds, timezone, channelKinds, channelLabels, location });
if (!data.today) {
  console.error(`No data for ${ds}`);
  process.exit(1);
}

const { subject, html } = dailyEmail.buildDailyReport(data);
console.log("SUBJECT:", subject);
fs.mkdirSync("/tmp/email-preview-serve", { recursive: true });
fs.writeFileSync("/tmp/email-preview-serve/index.html", html);
console.log("wrote /tmp/email-preview-serve/index.html");
