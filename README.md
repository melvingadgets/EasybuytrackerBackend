https://wa.me/2347086758713
# EasybuytrackerBackend

## Render Keep-Alive (GitHub Actions)

This repo includes a scheduled workflow at `.github/workflows/keep-render-awake.yml`.

Set this GitHub repository secret before use:

- `RENDER_HEALTH_URL=https://your-service.onrender.com/api/v1`

How it runs:

- Every 5 minutes (`cron: */5 * * * *`)
- Also manually from the Actions tab via `workflow_dispatch`

