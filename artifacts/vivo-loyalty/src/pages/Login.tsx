import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLogin } from "@/hooks/use-loyalty";
import { useAuth } from "@/hooks/use-auth";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import vivoLogo from "@assets/Vivo_Logo_Picture_1781198869845.png";

const formSchema = z.object({
  phone: z.string().min(9, "Phone number is too short"),
  pin: z.string().min(4, "PIN must be at least 4 digits").max(6, "PIN must be at most 6 digits"),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const loginMutation = useLogin();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      phone: "",
      pin: "",
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const res = await loginMutation.mutateAsync(values);
      login(res.token);
      setLocation("/");
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Login failed",
        description: error.message || "Could not sign in",
      });
    }
  }

  return (
    <MobileLayout>
      <div className="flex-1 flex flex-col justify-center px-6 py-12">
        <div className="mb-10 text-center flex flex-col items-center">
          <img src={vivoLogo} alt="Vivo" className="h-12 w-auto mb-4" />
          <h1 className="text-3xl font-bold tracking-tight text-primary">Rewards</h1>
          <p className="text-muted-foreground mt-2">Sign in to your membership</p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Number</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 0712345678" type="tel" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="pin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>PIN</FormLabel>
                  <FormControl>
                    <Input placeholder="••••" type="password" inputMode="numeric" maxLength={6} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button 
              type="submit" 
              className="w-full h-12 text-lg" 
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </Form>

        <div className="mt-8 text-center">
          <p className="text-sm text-muted-foreground">
            Not a member yet?{" "}
            <button 
              onClick={() => setLocation("/enrol")}
              className="font-medium text-primary hover:underline"
            >
              Join Rewards
            </button>
          </p>
        </div>
      </div>
    </MobileLayout>
  );
}
