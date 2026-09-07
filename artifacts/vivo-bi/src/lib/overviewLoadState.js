export function getOverviewLoadState({
  sectionLoading,
  kpiLoading,
  kpis,
  sectionError,
  kpiError,
}) {
  return {
    showSkeleton: (sectionLoading || kpiLoading) && !kpis && !sectionError && !kpiError,
    showError: Boolean(sectionError || (kpiError && !kpis)),
    showHeadline: !kpiLoading && Boolean(kpis),
  };
}