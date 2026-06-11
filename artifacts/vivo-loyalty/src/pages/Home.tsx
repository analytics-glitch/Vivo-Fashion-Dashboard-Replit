import { useAuth } from "@/hooks/use-auth";
import { useMemberMe, useRedeemPoints } from "@/hooks/use-loyalty";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { brandColor, brandLabel, fmtKES, fmtNum, fmtDate } from "@/lib/brand";
import Barcode from "react-barcode";
import { Bell, LogOut, ChevronRight, Gift, Activity, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const { token, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = useMemberMe(token);
  const redeemMutation = useRedeemPoints();
  const { toast } = useToast();
  const [redeemDialogOpen, setRedeemDialogOpen] = useState(false);
  const [redeemResult, setRedeemResult] = useState<{ discount_code: string; kes_value: number } | null>(null);

  if (error) {
    if ((error as any).status === 401) {
      logout();
      return null;
    }
    return (
      <MobileLayout>
        <div className="p-6 text-center text-destructive">
          <p>Failed to load profile. Please try again.</p>
        </div>
      </MobileLayout>
    );
  }

  if (isLoading || !data) {
    return (
      <MobileLayout>
        <div className="p-6 flex flex-col gap-6 animate-pulse">
          <div className="h-10 w-full bg-muted rounded-md" />
          <div className="h-64 w-full bg-muted rounded-2xl" />
          <div className="h-20 w-full bg-muted rounded-md" />
        </div>
      </MobileLayout>
    );
  }

  const { member, ledger, unread_messages, config } = data;
  const kesValue = Math.floor(member.points_balance / config.points_per_kes_redeem);
  const canRedeem = member.points_balance >= config.redemption_floor;

  const handleRedeem = async () => {
    try {
      const res = await redeemMutation.mutateAsync(member.points_balance);
      setRedeemResult({
        discount_code: res.discount_code,
        kes_value: res.kes_value
      });
      toast({
        title: "Points Redeemed!",
        description: "Your discount code is ready to use.",
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Redemption failed",
        description: e.message || "Could not redeem points.",
      });
    }
  };

  return (
    <MobileLayout>
      {/* Header */}
      <header className="px-6 py-4 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10">
        <h1 className="text-xl font-bold text-primary">Vivo Rewards</h1>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setLocation("/messages")}
            className="relative p-2 text-primary hover:bg-muted rounded-full transition-colors"
          >
            <Bell size={20} />
            {unread_messages > 0 && (
              <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-destructive rounded-full" />
            )}
          </button>
          <button 
            onClick={logout}
            className="p-2 text-muted-foreground hover:bg-muted rounded-full transition-colors"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-12">
        {/* Membership Card */}
        <div className="px-6 pt-2 pb-6">
          <div className="bg-[#0f3d24] text-white rounded-2xl p-6 shadow-xl relative overflow-hidden">
            {/* Decoration */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16 blur-xl" />
            <div className="absolute bottom-0 left-0 w-24 h-24 bg-[#1a5c38] rounded-full -ml-10 -mb-10 blur-xl" />

            <div className="relative z-10">
              <div className="flex justify-between items-start mb-8">
                <div>
                  <p className="text-white/70 text-sm font-medium uppercase tracking-wider mb-1">MEMBERSHIP</p>
                  <h2 className="text-2xl font-semibold tracking-tight">{member.name || "Valued Member"}</h2>
                </div>
                <div className="flex items-center gap-1.5 bg-black/20 px-3 py-1.5 rounded-full">
                  <div 
                    className="w-2.5 h-2.5 rounded-full" 
                    style={{ backgroundColor: brandColor(member.brand_code) }}
                  />
                  <span className="text-xs font-semibold uppercase tracking-wider">
                    {brandLabel(member.brand_code)}
                  </span>
                </div>
              </div>

              <div className="mb-8">
                <p className="text-white/70 text-sm mb-1">Available Points</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-bold">{fmtNum(member.points_balance)}</span>
                  <span className="text-white/70 text-sm font-medium">pts</span>
                </div>
                <p className="text-white/60 text-sm mt-1">
                  Worth approx. <span className="text-white font-medium">{fmtKES(kesValue)}</span>
                </p>
              </div>

              <div className="bg-white rounded-xl p-4 flex flex-col items-center justify-center">
                <div className="overflow-hidden">
                  <Barcode 
                    value={member.membership_code} 
                    width={1.8} 
                    height={50} 
                    displayValue={true} 
                    fontSize={14}
                    margin={0}
                    background="#ffffff"
                    lineColor="#000000"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-2 font-medium">Show this at the till to earn points</p>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="px-6 mb-8 grid grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
            <p className="text-muted-foreground text-xs uppercase font-bold tracking-wider mb-1">Current Tier</p>
            <p className="text-lg font-bold text-primary">{member.tier}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
            <p className="text-muted-foreground text-xs uppercase font-bold tracking-wider mb-1">Lifetime Pts</p>
            <p className="text-lg font-bold text-primary">{fmtNum(member.points_lifetime)}</p>
          </div>
        </div>

        {/* Action: Redeem */}
        <div className="px-6 mb-8">
          <div className="bg-accent/50 border border-accent rounded-xl p-5">
            <div className="flex items-start gap-4">
              <div className="bg-white p-3 rounded-full shadow-sm text-primary">
                <Gift size={24} />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-primary text-lg">Redeem Points</h3>
                <p className="text-sm text-muted-foreground mt-1 mb-3">
                  Convert your points into a discount code for your next purchase.
                </p>
                <div className="text-xs text-muted-foreground mb-4 bg-white/50 p-2 rounded flex items-center gap-2">
                  <Info size={14} />
                  <span>Minimum {config.redemption_floor} pts &middot; {config.points_per_kes_redeem} pts = KES 1</span>
                </div>
                
                <Dialog open={redeemDialogOpen} onOpenChange={(open) => {
                  if (!open) setRedeemResult(null);
                  setRedeemDialogOpen(open);
                }}>
                  <DialogTrigger asChild>
                    <Button 
                      className="w-full" 
                      disabled={!canRedeem}
                    >
                      {canRedeem ? "Redeem Now" : `Need ${fmtNum(config.redemption_floor - member.points_balance)} more pts`}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md w-[90vw] rounded-xl">
                    <DialogHeader>
                      <DialogTitle>Redeem Points</DialogTitle>
                      <DialogDescription>
                        {redeemResult 
                          ? "Here is your discount code."
                          : `You are about to convert ${fmtNum(member.points_balance)} points into a discount code worth ${fmtKES(kesValue)}.`}
                      </DialogDescription>
                    </DialogHeader>
                    
                    {redeemResult ? (
                      <div className="py-6 flex flex-col items-center justify-center space-y-4">
                        <div className="bg-green-50 border border-green-200 text-green-800 px-6 py-4 rounded-xl text-center w-full">
                          <p className="text-sm font-medium mb-1">Discount Code</p>
                          <p className="text-3xl font-mono font-bold tracking-widest">{redeemResult.discount_code}</p>
                          <p className="text-sm mt-2 font-bold">{fmtKES(redeemResult.kes_value)} off</p>
                        </div>
                        <p className="text-sm text-center font-medium">
                          Show this code at the till to apply your discount!
                        </p>
                      </div>
                    ) : (
                      <div className="py-4 text-center">
                        <p className="text-lg">Convert all <span className="font-bold text-primary">{fmtNum(member.points_balance)} pts</span>?</p>
                      </div>
                    )}
                    
                    <DialogFooter>
                      {redeemResult ? (
                        <Button className="w-full" onClick={() => setRedeemDialogOpen(false)}>Done</Button>
                      ) : (
                        <div className="flex gap-2 w-full">
                          <Button variant="outline" className="flex-1" onClick={() => setRedeemDialogOpen(false)}>Cancel</Button>
                          <Button 
                            className="flex-1" 
                            onClick={handleRedeem}
                            disabled={redeemMutation.isPending}
                          >
                            {redeemMutation.isPending ? "Redeeming..." : "Confirm Redeem"}
                          </Button>
                        </div>
                      )}
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>
        </div>

        {/* Ledger Activity */}
        <div className="px-6">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={18} className="text-muted-foreground" />
            <h3 className="font-semibold text-primary">Recent Activity</h3>
          </div>
          
          {ledger.length === 0 ? (
            <div className="bg-card border border-border border-dashed rounded-xl p-6 text-center text-muted-foreground">
              <p className="text-sm">No activity yet.</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
              <div className="divide-y divide-border">
                {ledger.map((entry, i) => (
                  <div key={i} className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-foreground">{entry.reason}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{fmtDate(entry.created_at)}</p>
                    </div>
                    <div className="text-right">
                      <p className={`font-bold text-sm ${entry.points_change > 0 ? "text-green-600" : entry.points_change < 0 ? "text-red-500" : "text-foreground"}`}>
                        {entry.points_change > 0 ? "+" : ""}{fmtNum(entry.points_change)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{fmtNum(entry.balance_after)} pts</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </MobileLayout>
  );
}
