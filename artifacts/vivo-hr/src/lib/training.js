// No training dataset exists in this project, so the Training page renders an
// empty "no data yet" state. This stub mimics the axios client surface the
// reference used (`trainingClient.get(path)` → `{ data }`) but always resolves
// to empty data instead of calling an external training API.
//
// The shape of each response must match what Training.jsx consumes:
//   /overview  → an object (or null) read field-by-field (setOverview)
//   /lateness  → an object with array members { by_training, detail }
//   everything else → an array the page iterates with .map()
export const TRAINING_API = "/api/hr/training";

export const trainingClient = {
  get: async (path) => {
    const clean = (path || "").split("?")[0];
    if (clean === "/overview") return { data: null };
    if (clean === "/lateness") return { data: { by_training: [], detail: [] } };
    if (clean === "/filters")
      // Training.jsx reads object members (filters.categories, etc.) and uses
      // earliest/latest_date to seed its date pickers — return an object, not
      // an array, so destructuring is stable in the no-data state.
      return {
        data: {
          categories: [],
          training_names: [],
          departments: [],
          delivery_methods: [],
          locations: [],
          earliest_date: null,
          latest_date: null,
        },
      };
    // training-status, duration, budget, by-department, by-delivery-method,
    // top-employees, monthly-trend, facilitators, employee-history
    // → empty arrays so .map() / `|| []` fallbacks behave.
    return { data: [] };
  },
};
