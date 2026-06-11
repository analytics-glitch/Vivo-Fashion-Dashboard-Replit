import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";

import Home from "@/pages/Home";
import Login from "@/pages/Login";
import Enrol from "@/pages/Enrol";
import Messages from "@/pages/Messages";
import NotFound from "@/pages/not-found";
import { useEffect } from "react";

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component }: { component: React.ComponentType<any> }) {
  const { token } = useAuth();
  
  if (token === null) {
    return <Redirect to="/login" />;
  }
  
  return <Component />;
}

function Router() {
  const { token } = useAuth();

  useEffect(() => {
    document.title = "Vivo Rewards";
  }, []);

  return (
    <Switch>
      <Route path="/" component={() => <ProtectedRoute component={Home} />} />
      <Route path="/login" component={Login} />
      <Route path="/enrol" component={Enrol} />
      <Route path="/messages" component={() => <ProtectedRoute component={Messages} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
