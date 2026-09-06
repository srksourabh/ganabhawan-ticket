import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="page-pad" style={{ display: 'flex', minHeight: '70vh', alignItems: 'center', justifyContent: 'center' }}>
      <SignIn
        appearance={{
          elements: {
            rootBox: 'mx-auto',
            card: 'shadow-none border border-[#e0d5c8]',
          },
        }}
        forceRedirectUrl="/catalogue"
        signUpUrl="/sign-up"
      />
    </main>
  );
}
