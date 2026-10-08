import StaffLoginForm from '@/components/StaffLoginForm';

/** Gate staff login: scanner and supervisor accounts, straight to the scanner. */
export default function GateLoginPage() {
  return (
    <StaffLoginForm
      portal="gate"
      eyebrow="Scanner / Supervisor"
      title="Gate Staff Login"
      intro="For ticket scanning at the entrance. Sign in with the email and password your organiser gave you."
      next="/gate"
      otherLabel="Organiser or office staff? Use Admin Login"
      otherHref="/admin/login"
    />
  );
}
