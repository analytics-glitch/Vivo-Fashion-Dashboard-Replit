import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  fetchMemberMe, 
  redeemPoints, 
  fetchMemberMessages, 
  markMessageRead, 
  enrolMember, 
  loginMember,
  ApiError 
} from "@/lib/member";

export function useMemberMe(token: string | null) {
  return useQuery({
    queryKey: ["memberMe"],
    queryFn: fetchMemberMe,
    enabled: !!token,
    retry: false
  });
}

export function useMemberMessages(token: string | null) {
  return useQuery({
    queryKey: ["memberMessages"],
    queryFn: fetchMemberMessages,
    enabled: !!token
  });
}

export function useMarkMessageRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markMessageRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memberMessages"] });
      queryClient.invalidateQueries({ queryKey: ["memberMe"] });
    }
  });
}

export function useRedeemPoints() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: redeemPoints,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memberMe"] });
    }
  });
}

export function useEnrol() {
  return useMutation({
    mutationFn: enrolMember
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: loginMember
  });
}
