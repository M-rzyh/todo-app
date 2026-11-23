# To-Do

A Todoist-style to-do list that stores every task in **Google Calendar**, so it syncs to every device without needing a server or database.

- **Today**, **Upcoming** (week strip and day-by-day list), **All tasks**, plus filters by priority and label
- Each task has a **name, description, deadline** (date, with an optional time), **repeat**, **priority** (P1–P4) and **labels**
- **Quick add** in natural language: `Submit report tomorrow 5pm p1 #lab every monday // attach figures`
- Installable app with shortcuts on the Mac dock and phone home screen (a PWA), which also works offline for viewing
- Tasks added or changed in Google Calendar, or by Claude, show up in the app

## How tasks are stored

All tasks live on a dedicated Google Calendar named **To-Do**, which the app creates on first sign-in.

| Task field  | Google Calendar event |
|-------------|----------------------|
| Name        | Title. A `✓ ` prefix means it's done |
| Description | Description, followed by a footer: `—` / `Priority: P1 · Labels: #lab #urgent` |
| Deadline    | All-day event (date only), or a 30-minute event at the deadline time |
| Repeat      | Recurrence rule (RRULE) |
| Priority    | Event colour: P1 Tomato, P2 Tangerine, P3 Blueberry, P4 default |
| Done        | `✓ ` title prefix. For repeating tasks, only that one occurrence is marked done |

Because everything uses normal event fields, you can add a task straight from Google Calendar. Put it on the To-Do calendar, and add the footer lines if you want a priority or labels.

## Quick add syntax

| Type        | Examples |
|-------------|----------|
| Date        | `today`, `tomorrow`, `fri`, `next week`, `Dec 15`, `15 Dec`, `12/15`, `2026-12-15`, `in 3 days` |
| Time        | `5pm`, `5:30pm`, `14:30`, `noon`, `tonight` |
| Priority    | `p1` `p2` `p3` `p4` |
| Labels      | `#lab` `#research` |
| Repeat      | `every day`, `every weekday`, `every mon, wed and fri`, `every 2 weeks`, `every other day`, `monthly`, `until Dec 31` |
| Description | Anything after ` // ` |

Keyboard shortcuts: `q` add task, `/` search, `t` Today, `u` Upcoming, `r` sync.

## Connect Google Calendar (one-time, about 10 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com/projectcreate) and create a project called `todo-app`.
2. Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and click **Get started**:
   - App name `To-Do`, support email: your email
   - Audience: **External**
   - Contact email: your email, then **Create**
4. Under **Audience → Test users**, add your own Google account.
5. Under **Clients → Create client**:
   - Type: **Web application**
   - Authorized JavaScript origins: `https://m-rzyh.github.io` (and `http://localhost:8000` if you also want to run it locally)
   - Copy the **Client ID**.
6. Open the app, paste the Client ID, and click **Connect Google Calendar**. You can also put it in `js/config.js` so it works on every device without pasting.

> Google shows an "unverified app" warning because the app is in testing mode and only for you. Click **Continue**. Sign-in lasts about an hour, after which the app shows a **Reconnect** button.

## Install it as an app

- **Mac (Chrome):** open the site, then choose ⋮ → *Cast, save and share* → *Install page as app*. Right-click the dock icon for the **Add task / Today / Upcoming** shortcuts.
- **Mac (Safari):** File → *Add to Dock*.
- **iPhone:** in Safari, tap Share → *Add to Home Screen*.

## "Hey Siri, add to my to-do list"

In the **Shortcuts** app on iPhone or Mac:

1. Create a new shortcut named **Add to my to-do list**.
2. Add the action **Dictate Text** (or *Ask for Input* if you'd rather type).
3. Add **URL Encode** using the *Dictated Text*.
4. Add **Open URLs** with `https://m-rzyh.github.io/todo-app/?add=` followed by the *URL Encoded Text* variable.

Now say "Hey Siri, add to my to-do list", then something like "call the dentist Friday at 9am p2". The app opens and adds the task.

## Ask Claude

With Google Calendar connected to Claude, say "add to my to-do list: …". Claude creates the event on the **To-Do** calendar using the same format (description footer for priority and labels, colour for priority, and RRULE for repeats).

## Development

The app is plain HTML, CSS and JavaScript modules, with no build step.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

`Demo mode` (on the setup screen) keeps tasks in the browser only, which is handy for trying changes without touching your calendar.

Files: `js/app.js` (UI), `js/parser.js` (quick add), `js/meta.js` (task ↔ event), `js/gcal.js` (Google API plus the demo backend), `js/dates.js`, `sw.js` (offline cache).
