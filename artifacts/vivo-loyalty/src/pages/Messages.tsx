import { useAuth } from "@/hooks/use-auth";
import { useMemberMessages, useMarkMessageRead } from "@/hooks/use-loyalty";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { fmtDate } from "@/lib/brand";
import { ArrowLeft, MailOpen, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Messages() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const { data, isLoading } = useMemberMessages(token);
  const markReadMutation = useMarkMessageRead();
  const { toast } = useToast();

  const handleMessageClick = async (id: number, read: boolean) => {
    if (!read) {
      try {
        await markReadMutation.mutateAsync(id);
      } catch (e: any) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Could not mark message as read.",
        });
      }
    }
  };

  return (
    <MobileLayout>
      <header className="px-4 py-4 flex items-center gap-3 sticky top-0 bg-background/80 backdrop-blur-md z-10 border-b border-border/50">
        <Button variant="ghost" size="icon" className="rounded-full h-10 w-10 shrink-0" onClick={() => setLocation("/")}>
          <ArrowLeft size={20} />
        </Button>
        <h1 className="text-xl font-bold text-primary">Messages</h1>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="space-y-4 animate-pulse">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 w-full bg-muted rounded-xl" />
            ))}
          </div>
        ) : !data || data.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 mt-20">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center text-muted-foreground mb-4">
              <MailOpen size={32} />
            </div>
            <h2 className="text-lg font-semibold text-primary mb-2">No messages yet</h2>
            <p className="text-muted-foreground text-sm">
              We'll notify you here about special offers, announcements, and rewards.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {data.messages.map((msg) => (
              <div 
                key={msg.id}
                onClick={() => handleMessageClick(msg.id, msg.read)}
                className={`p-5 rounded-xl border transition-all cursor-pointer ${
                  msg.read 
                    ? "bg-card border-border shadow-sm" 
                    : "bg-white border-primary shadow-md relative"
                }`}
              >
                {!msg.read && (
                  <div className="absolute top-5 right-5 w-2.5 h-2.5 bg-destructive rounded-full" />
                )}
                <div className="flex items-start gap-3 mb-2">
                  <div className={`mt-0.5 ${msg.read ? "text-muted-foreground" : "text-primary"}`}>
                    {msg.read ? <MailOpen size={18} /> : <Mail size={18} />}
                  </div>
                  <div>
                    <h3 className={`font-semibold ${msg.read ? "text-foreground" : "text-primary pr-4"}`}>
                      {msg.title}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <span>{fmtDate(msg.created_at)}</span>
                      {msg.created_by_name && (
                        <>
                          <span>&middot;</span>
                          <span>{msg.created_by_name}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-sm text-foreground/80 mt-3 leading-relaxed pl-8">
                  {msg.body}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>
    </MobileLayout>
  );
}
