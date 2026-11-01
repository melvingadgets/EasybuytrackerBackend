https://wa.me/2347086758713
# EasybuytrackerBackend

## Render Keep-Alive (GitHub Actions)

This repo includes a scheduled workflow at `.github/workflows/keep-render-awake.yml`.

Set this GitHub repository secret before use:

- `RENDER_HEALTH_URL=https://your-service.onrender.com/api/v1`

How it runs:

- Every 5 minutes (`cron: */5 * * * *`)
- Also manually from the Actions tab via `workflow_dispatch`

## Repayment reminders

The API runs a daily job that tells customers about unpaid instalments: 3 days before, on the due day, and when overdue. Each reminder is one `easybuy.repayment.due` event, and auth turns it into a notice and a device alert. The design is in `Shortwork/docs/notifications.md` §13.

Set these to turn it on:

- `EVENTS_ENABLED=true`
- `REPAYMENT_REMINDERS_ENABLED=true`, only once the relay routes the event and auth reads it

A run starts between 08:00 and 20:00 Lagos time. To see what a run would send, without sending it:

```bash
DATABASE_URL=... PORT=0 JWT_SECRET=... npx tsx run-repayment-reminders.ts
```

Add `--today=YYYY-MM-DD` to preview another day, or `--write` to send. A database that isn't on this machine also needs `--allow-remote`.
