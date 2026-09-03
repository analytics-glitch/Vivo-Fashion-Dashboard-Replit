import re

with open('artifacts/vivo-product-workspace/src/App.tsx', 'r') as f:
    content = f.read()

dashboard_start = content.find('function Dashboard() {')
# find the next function definition after Dashboard
next_func = content.find('function Login() {', dashboard_start)

if dashboard_start == -1 or next_func == -1:
    print("Could not find Dashboard or Login function")
    exit(1)

new_dashboard = """type FocusWeek = { isoYear: number; isoWeek: number; stylesCommitted: number; unitsCommitted: number; weeklyPaceUnits: number; monthlyPlanUnits: number; monthLabel: string; varianceUnits: number; status: string };
type FocusNewness = { newUnits: number; totalUnits: number; pct: number; monthlyFloorPct: number; scorecardGoalPct: number; meetsMonthlyFloor: boolean; meetsScorecardGoal: boolean; discrepancy: number };
type FocusGap = { subCategory: string; plannedNewStyles: number; availableNewStyles: number; balance: number; status: string };
type FocusWaiting = { sampleApprovals: number; setSampleApprovals: number; fabricBlocks: number; total: number };
type FocusScorecard = { key: string; owner: string; measurable: string; goal: number; value: number; uom: string; onTrack: boolean; available: boolean; note?: string };
type WorkspaceDashboardFocus = { week: FocusWeek; newness: FocusNewness; gaps: FocusGap[]; waiting: FocusWaiting; scorecard: FocusScorecard[] };

function Dashboard() {
  const dashboard = useGetWorkspaceDashboard({ query: { queryKey: getGetWorkspaceDashboardQueryKey() } });
  const birthdays = useQuery<TodayBirthday[]>({
    queryKey: ['workspace', 'team', 'birthdays', 'today'],
    queryFn: async () => {
      const response = await fetch('/api/team/birthdays/today', { credentials: 'include' });
      if (!response.ok) throw new Error('Could not load today’s birthdays');
      return response.json() as Promise<TodayBirthday[]>;
    },
    retry: false,
    staleTime: 60_000,
  });
  if (dashboard.isLoading) return <section className="page"><LoadingState /></section>;
  if (dashboard.isError || !dashboard.data) return <section className="page"><ErrorState onRetry={() => dashboard.refetch()} /></section>;
  
  const data = dashboard.data;
  const snapshot: WorkspaceDashboardSnapshot = data.snapshot;
  const focus = (data as any).focus as WorkspaceDashboardFocus | undefined;
  
  const snapshotDate = new Date(`${snapshot.asOfDate}T12:00:00`);
  const snapshotDateLabel = Number.isNaN(snapshotDate.getTime())
    ? snapshot.asOfDate
    : snapshotDate.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

  const subtitle = focus?.week 
    ? `Week ${focus.week.isoWeek} · ${focus.week.stylesCommitted} styles committed. ${focus.waiting?.sampleApprovals || 0} sample approvals and ${focus.waiting?.fabricBlocks || 0} fabric blocks outstanding.`
    : "The decisions shaping the next Vivo collection.";

  return (
    <section className="page dashboard-page">
      <PageHeading 
        eyebrow={snapshotDateLabel} 
        title="Good morning, team." 
        description={subtitle} 
        action={<Link className="button button-gold" href="/product-workspace/plan" data-testid="link-open-plan">Open Q3 plan <ArrowRight size={16} /></Link>} 
      />
      
      {birthdays.data?.length ? (
        <div className="snapshot-birthday" role="status" data-testid="snapshot-birthdays-today" style={{ marginBottom: 24, marginTop: -8 }}>
          <Sparkles size={16} aria-hidden="true" style={{ color: '#ae8746' }} />
          <strong>Happy Birthday {birthdays.data.map((member) => member.name).join(', ')}!</strong>
        </div>
      ) : null}

      <div className="dash-brief">
        {focus && (
          <div className="dash-action-grid">
            <div className="dash-action-tile" data-testid="tile-week-plan">
              <h3 className="dash-tile-title">
                This week
                <CalendarDays size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{focus.week.weeklyPaceUnits.toLocaleString()}</span>
                <span className="dash-tile-sub">units to plan</span>
              </div>
              <div className={`dash-tile-status ${focus.week.varianceUnits < 0 ? 'danger' : 'success'}`}>
                {focus.week.varianceUnits < 0 ? <CircleAlert size={14} /> : <Check size={14} />}
                <span>
                  {Math.abs(focus.week.varianceUnits).toLocaleString()} units {focus.week.varianceUnits < 0 ? 'behind' : 'ahead'}
                </span>
              </div>
            </div>

            <div className="dash-action-tile" data-testid="tile-newness">
              <h3 className="dash-tile-title">
                Newness
                <Sparkles size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{focus.newness.pct}%</span>
                <span className="dash-tile-sub">{focus.newness.newUnits} of {focus.newness.totalUnits} styles</span>
              </div>
              <div className={`dash-tile-status ${!focus.newness.meetsMonthlyFloor ? 'danger' : !focus.newness.meetsScorecardGoal ? 'warning' : 'success'}`}>
                {!focus.newness.meetsMonthlyFloor ? <CircleAlert size={14} /> : <Check size={14} />}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>{focus.newness.meetsMonthlyFloor ? 'Meets' : 'Misses'} {focus.newness.monthlyFloorPct}% floor</span>
                  {!focus.newness.meetsScorecardGoal && (
                    <span style={{ fontSize: 10, color: 'var(--color-muted-foreground)' }}>L10 goal is {focus.newness.scorecardGoalPct}%</span>
                  )}
                </div>
              </div>
            </div>

            <div className="dash-action-tile" data-testid="tile-gaps">
              <h3 className="dash-tile-title">
                Style Gaps
                <Columns3 size={14} />
              </h3>
              <div className="dash-gap-list">
                {focus.gaps.length > 0 ? (
                  focus.gaps.map((gap) => (
                    <div key={gap.subCategory} className={`dash-gap-item ${gap.balance < 0 ? 'shortfall' : gap.balance > 0 ? 'surplus' : ''}`}>
                      <span>{gap.subCategory}</span>
                      <strong>{gap.balance > 0 ? '+' : ''}{gap.balance}</strong>
                    </div>
                  ))
                ) : (
                  <span className="dash-tile-sub" style={{ padding: '8px 0' }}>All categories balanced</span>
                )}
              </div>
            </div>

            <Link href="/product-workspace/style-development" className="dash-action-tile" data-testid="tile-waiting">
              <h3 className="dash-tile-title">
                Waiting on you
                <Clock3 size={14} />
              </h3>
              <div className="dash-waiting-list" style={{ marginTop: 'auto' }}>
                <div className={`dash-waiting-item ${focus.waiting.sampleApprovals > 0 ? 'critical' : ''}`}>
                  <span>Sample approvals</span>
                  <strong>{focus.waiting.sampleApprovals}</strong>
                </div>
                <div className={`dash-waiting-item ${focus.waiting.fabricBlocks > 0 ? 'critical' : ''}`}>
                  <span>Fabric blocks</span>
                  <strong>{focus.waiting.fabricBlocks}</strong>
                </div>
              </div>
            </Link>
          </div>
        )}

        {focus?.scorecard && (
          <div className="dash-scorecard-section" data-testid="scorecard-section">
            <div className="dash-scorecard-header">
              <h3>Weekly L10 Scorecard</h3>
              <div className="dash-scorecard-meta">
                <span>Week {focus.week.isoWeek}</span>
                <span>•</span>
                <span>{focus.week.monthLabel}</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="dash-scorecard-table">
                <thead>
                  <tr>
                    <th>Measurable</th>
                    <th className="owner">Owner</th>
                    <th>Goal</th>
                    <th>Actual</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {focus.scorecard.map((row) => (
                    <tr key={row.key}>
                      <td className="measurable">{row.measurable}</td>
                      <td className="owner">{row.owner}</td>
                      <td className="goal">
                        {row.goal}
                        {row.uom && ` ${row.uom}`}
                      </td>
                      <td className="value">
                        {row.available ? (
                          <>
                            {row.value}
                            {row.uom && ` ${row.uom}`}
                          </>
                        ) : (
                          <span style={{ color: 'var(--color-muted-foreground)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {row.available ? (
                          <span className={`dash-scorecard-status ${row.onTrack ? 'on-track' : 'off-track'}`}>
                            {row.onTrack ? 'On Track' : 'Off Track'}
                          </span>
                        ) : (
                          <span className="dash-scorecard-status unavailable">N/A</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="dashboard-columns">
          <div className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">The room</span>
                <h3>Recent activity</h3>
              </div>
              <Link className="text-button" href="/product-workspace/rocks" data-testid="link-view-activity">
                View all <ArrowRight size={14} />
              </Link>
            </div>
            {data.activity?.length ? data.activity.slice(0, 5).map((item: any, i: number) => (
              <div className="activity-row" key={i} data-testid={`row-activity-${i}`}>
                <div className="activity-mark">
                  {i % 2 ? <MessageCircle size={15} /> : <Check size={15} />}
                </div>
                <div>
                  <strong>{fmt(getPathValue(item, ['title', 'action', 'name']), 'Collection update')}</strong>
                  <p>{fmt(getPathValue(item, ['detail', 'description', 'body']), 'A decision was logged in the workspace.')}</p>
                </div>
                <time>{date(getPathValue(item, ['time', 'createdAt']))}</time>
              </div>
            )) : <EmptyState title="The room is quiet" text="Activity will appear here as the team moves product forward." />}
          </div>
          <div className="panel upcoming-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Next up</span>
                <h3>Key dates</h3>
              </div>
              <CalendarDays size={18} />
            </div>
            {data.upcoming?.length ? data.upcoming.slice(0, 4).map((item: any, i: number) => (
              <div className="upcoming-row" key={i} data-testid={`row-upcoming-${i}`}>
                <div className="date-block">
                  <b>{fmt(getPathValue(item, ['day', 'date']), '18')}</b>
                  <span>{fmt(getPathValue(item, ['month']), 'JUN')}</span>
                </div>
                <div>
                  <strong>{fmt(getPathValue(item, ['title', 'name']), 'Range review')}</strong>
                  <p>{fmt(getPathValue(item, ['detail', 'description']), 'Product team')}</p>
                </div>
              </div>
            )) : <EmptyState title="No dates on deck" text="Your next reviews will show up here." />}
          </div>
        </div>
      </div>
    </section>
  );
}
"""

new_content = content[:dashboard_start] + new_dashboard + content[next_func:]

with open('artifacts/vivo-product-workspace/src/App.tsx', 'w') as f:
    f.write(new_content)

print("Replaced Dashboard successfully.")
