// App configuration.
// GOOGLE_CLIENT_ID: the OAuth "Web application" client ID from Google Cloud
// (see README → "Connect Google Calendar"). It can also be pasted on the app's
// setup screen, which stores it in this browser only.
export const CONFIG = {
  GOOGLE_CLIENT_ID: '1072514538366-rrn3tph14di84up5lhsgdtmfsh253rd2.apps.googleusercontent.com',
  CALENDAR_NAME: 'To-Do',        // the Google Calendar that holds your tasks
  DEFAULT_DURATION_MIN: 30,      // length of a timed task's calendar block
  FETCH_DAYS_BACK: 90,           // how far back to look for overdue tasks
  FETCH_DAYS_AHEAD: 180,         // how far ahead to load upcoming tasks
};
