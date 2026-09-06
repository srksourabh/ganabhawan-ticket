import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main className="page-pad" style={{ display: 'flex', minHeight: '70vh', alignItems: 'center', justifyContent: 'center' }}>
      <SignUp
        appearance={{
          elements: {
            rootBox: 'mx-auto',
            card: 'shadow-none border border-[#e0d5c8]',
          },
        }}
        forceRedirectUrl="/catalogue"
        signInUrl="/sign-in"
      />
    </main>
  );
}
