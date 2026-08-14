import { VivoLogo } from "@/components/community/ui";
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
        <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-6 text-center">
          <div className="mb-4"><VivoLogo size="md" /></div>
          <p className="text-muted-foreground mb-8 text-[15px]">Something went wrong. Please refresh the page.</p>
          <button
            onClick={() => window.location.reload()}
            className="h-11 px-8 rounded bg-primary text-primary-foreground font-medium text-[15px] transition-all hover:opacity-90 active:scale-[0.98]"
          >
            Refresh Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Splash() {
  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center">
      <div className="animate-pulse"><VivoLogo size="lg" /></div>
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