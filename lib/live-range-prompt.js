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

async function askField(askFn, label, defaultValue, validate) {
  for (;;) {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    const raw = await askFn(`${label}${hint}: `);
    const candidate = String(raw ?? '').trim() || String(defaultValue || '').trim();
    const result = validate(candidate);
    if (result.ok) {
      return { value: result.value, label: result.label };
    }
    logErr(result.error);
  }
}

async function promptClipRange(item, askFn) {
  const defaults = defaultLiveRangeFromItem(item);
  const tz = localTimezoneLabel();
  const exampleDate = todayLocalDayMonthString();

  console.log('');
  logInfo(`Catchup clip — ${tz} → Australian time in URL`);
  console.log(colorEnabled()
    ? `${C.dim}Date: ${exampleDate}   Time: 06:00:00   Duration: seconds (e.g. 185) or 00:03:05${C.reset}`
    : `Date: ${exampleDate}   Time: 06:00:00   Duration: seconds (e.g. 185) or 00:03:05`);

  const startDateResult = await askField(
    askFn,
    'Start date (DD MM)',
    defaults.startDate,
    (value) => validateStrictDateInput(value, {
      fieldLabel: 'Start date',
      yearHint: defaults.startYearHint,
    }),
  );

  const startTimeResult = await askField(
    askFn,
    'Start time',
    defaults.start,
    (value) => validateStrictTimeInput(value, { fieldLabel: 'Start time' }),
  );

  const durationResult = await askField(
    askFn,
    'Duration (seconds or HH:MM:SS)',
    defaults.duration,
    (value) => validateDurationInput(value),
  );

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
    return promptClipRange(item, askFn);
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

/** Live channels only — must pick 1 (record) or 2 (catchup clip). */
async function promptLiveRange(item, askFn) {
  for (;;) {
    console.log('');
    logInfo('Live channel — choose mode');
    console.log(colorEnabled()
      ? `${C.bold}  1.${C.reset} Record live${colorEnabled() ? C.reset : ''}`
      : '  1. Record live');
    console.log(colorEnabled()
      ? `${C.bold}  2.${C.reset} Catchup clip${colorEnabled() ? C.reset : ''}`
      : '  2. Catchup clip');

    const choice = String(await askFn('Select [1/2]: ') || '').trim();
    if (choice === '1') {
      logInfo('Recording live stream.');
      return { liveClip: false, liveRange: null };
    }
    if (choice === '2') {
      const liveRange = await promptClipRange(item, askFn);
      return { liveClip: true, liveRange };
    }
    logErr('Enter 1 or 2.');
  }
}

module.exports = { promptLiveRange };
