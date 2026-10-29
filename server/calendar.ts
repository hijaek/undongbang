import {Temporal} from '@js-temporal/polyfill';
const DEFAULT_TIMEZONE='America/New_York';
export function localDate(instant:string,zone=DEFAULT_TIMEZONE){return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate().toString();}
export function weekAt(instant=new Date().toISOString(),zone=DEFAULT_TIMEZONE){const d=Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate();return d.subtract({days:d.dayOfWeek-1}).toString();}
export function weekEnds(week:string,zone=DEFAULT_TIMEZONE){return Temporal.PlainDate.from(week).add({days:7}).toZonedDateTime({timeZone:zone,plainTime:'00:00'}).toInstant().toString();}
export function isWeek(week:unknown):week is string{try{return typeof week==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(week)&&Temporal.PlainDate.from(week).dayOfWeek===1;}catch{return false;}}
