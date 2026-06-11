import { useState, useEffect } from "react";
import { loadMemberToken, getMemberToken, setMemberToken, logoutMember } from "@/lib/member";

export function useAuth() {
  const [token, setToken] = useState<string | null>(getMemberToken());
  
  useEffect(() => {
    setToken(loadMemberToken());
  }, []);

  const login = (newToken: string) => {
    setMemberToken(newToken);
    setToken(newToken);
  };

  const logout = async () => {
    await logoutMember();
    setToken(null);
  };

  return { token, login, logout };
}
