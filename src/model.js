// États de base partagés par les clients de sources de données.

export const Source = Object.freeze({
  Live: 'live',
  Cache: 'cache',
  Stale: 'stale',
});

export function isLiveSource(source) {
  return source === Source.Live;
}

export const MatchState = Object.freeze({
  Scheduled: 'SCHEDULED',
  InProgress: 'IN_PROGRESS',
  Finished: 'FINISHED',
  Postponed: 'POSTPONED',
  Cancelled: 'CANCELLED',
});
