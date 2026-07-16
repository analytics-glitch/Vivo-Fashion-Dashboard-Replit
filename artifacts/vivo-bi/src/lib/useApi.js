import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useApi(url, params = {}, options = {}) {
  return useQuery({
    queryKey: [url, params],
    queryFn: () => api.get(url, { params }).then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    ...options,
  });
}
