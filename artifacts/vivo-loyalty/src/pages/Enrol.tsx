import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useEnrol } from "@/hooks/use-loyalty";
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
  name: z.string().min(2, "Name is required"),
  phone: z.string().min(9, "Phone number is required"),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  pin: z.string().min(4, "PIN must be at least 4 digits").max(6, "PIN must be at most 6 digits"),
});

export default function Enrol() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const enrolMutation = useEnrol();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      phone: "",
      email: "",
      pin: "",
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const payload = {
        ...values,
        email: values.email || undefined
      };
      const res = await enrolMutation.mutateAsync(payload);
      login(res.token);
      setLocation("/");
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Registration failed",
        description: error.message || "Could not create account",
      });
    }
  }

  return (
    <MobileLayout>
      <div className="flex-1 flex flex-col justify-center px-6 py-10">
        <div className="mb-8 text-center flex flex-col items-center">
          <img src={vivoLogo} alt="Vivo" className="h-12 w-auto mb-4" />
          <h1 className="text-3xl font-bold tracking-tight text-primary">Join Rewards</h1>
          <p className="text-muted-foreground mt-2">Earn points on every purchase</p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Jane Doe" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="jane@example.com" type="email" {...field} />
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
                  <FormLabel>Choose a PIN (4-6 digits)</FormLabel>
                  <FormControl>
                    <Input placeholder="••••" type="password" inputMode="numeric" maxLength={6} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button 
              type="submit" 
              className="w-full h-12 text-lg mt-2" 
              disabled={enrolMutation.isPending}
            >
              {enrolMutation.isPending ? "Creating Account..." : "Join Now"}
            </Button>
          </form>
        </Form>

        <div className="mt-8 text-center pb-4">
          <p className="text-sm text-muted-foreground">
            Already a member?{" "}
            <button 
              onClick={() => setLocation("/login")}
              className="font-medium text-primary hover:underline"
            >
              Sign In
            </button>
          </p>
        </div>
      </div>
    </MobileLayout>
  );
}
