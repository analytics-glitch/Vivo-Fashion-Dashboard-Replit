import React from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import AuthFlow from '@/screens/AuthFlow';
import CommunityShell from '@/screens/CommunityShell';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[100dvh] bg-[#fbf9f6] flex flex-col items-center justify-center px-6 text-center">
          <div className="text-3xl font-black tracking-[0.35em] text-[#2c2a29] mb-4">VIVO</div>
          <p className="text-[#7a746e] mb-6">Something went wrong. Please refresh the page.</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-xl font-bold text-sm bg-[#c25e30] text-white"
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Splash() {
  return (
    <div className="min-h-[100dvh] bg-[#fbf9f6] flex items-center justify-center">
      <div className="text-3xl font-black tracking-[0.35em] text-[#2c2a29] animate-pulse">VIVO</div>
    </div>
  );
}

function Root() {
  const { member, loading } = useAuth();
  if (loading) return <Splash />;
  return member ? <CommunityShell /> : <AuthFlow />;
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
