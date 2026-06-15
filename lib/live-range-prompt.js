'use strict';

const {
  defaultLiveRangeFromItem,
  buildLiveRangeFromStartAndDuration,
  validateStrictDateInput,
  validateStrictTimeInput,
  validateDurationInput,
  todayLocalDayMonthString,
  localTimezoneLabel,
} = require('./mpd-formatter');
const { logInfo, logOk, logErr, colorEnabled, C } = require('./ui');

function isSkipInput(raw) {
  return /^(s|skip)$/i.test(String(raw || '').trim());
}

async function askField(askFn, label, defaultValue, validate) {
  for (;;) {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    const raw = await askFn(`${label}${hint}: `);
    if (isSkipInput(raw)) {
      return { skipped: true };
    }
    const candidate = String(raw ?? '').trim() || String(defaultValue || '').trim();
    const result = validate(candidate);
    if (result.ok) {
      return { value: result.value, label: result.label };
    }
    logErr(result.error);
  }
}

async function promptLiveRange(item, askFn) {
  const defaults = defaultLiveRangeFromItem(item);
  const tz = localTimezoneLabel();
  const exampleDate = todayLocalDayMonthString();

  console.log('');
  logInfo(`Live clip — ${tz} → Australian time in URL`);
  console.log(colorEnabled()
    ? `${C.dim}Date: ${exampleDate}   Time: 06:00:00   Duration: seconds (e.g. 185) or 00:03:05   Enter = default   skip = no clip${C.reset}`
    : `Date: ${exampleDate}   Time: 06:00:00   Duration: seconds (e.g. 185) or 00:03:05   Enter = default   skip = no clip`);

  const startDateResult = await askField(
    askFn,
    'Start date (DD MM)',
    defaults.startDate,
    (value) => validateStrictDateInput(value, {
      fieldLabel: 'Start date',
      yearHint: defaults.startYearHint,
    }),
  );
  if (startDateResult.skipped) {
    logInfo('Skipping live range.');
    return null;
  }

  const startTimeResult = await askField(
    askFn,
    'Start time',
    defaults.start,
    (value) => validateStrictTimeInput(value, { fieldLabel: 'Start time' }),
  );
  if (startTimeResult.skipped) {
    logInfo('Skipping live range.');
    return null;
  }

  const durationResult = await askField(
    askFn,
    'Duration (seconds or HH:MM:SS)',
    defaults.duration,
    (value) => validateDurationInput(value),
  );
  if (durationResult.skipped) {
    logInfo('Skipping live range.');
    return null;
  }

  const validated = buildLiveRangeFromStartAndDuration(
    startDateResult.value,
    startTimeResult.value,
    durationResult.value,
    { yearHint: defaults.startYearHint },
  );

  if (!validated.ok) {
    for (const err of validated.errors) {
      logErr(err);
    }
    logErr('Could not build clip — try again.');
    return promptLiveRange(item, askFn);
  }

  const { range, preview } = validated;
  logOk(`Clip: ${range.startDateDisplay} ${range.start} + ${durationResult.label || `${preview.durationSec} sec`} → ${range.endDateDisplay} ${range.end} (${tz})`);
  logInfo(`Australian URL: start=${preview.startAu}`);
  logInfo(`Australian URL: end=${preview.endAu}`);

  return {
    ...range,
    startYearHint: defaults.startYearHint,
  };
}

module.exports = { promptLiveRange, isSkipInput };
