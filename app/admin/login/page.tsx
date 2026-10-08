import StaffLoginForm from '@/components/StaffLoginForm';

/** Admin login: owner, inventory, finance and desk staff. */
export default function AdminLoginPage() {
  return (
    <StaffLoginForm
      portal="admin"
      eyebrow="সমতট নাট্যমেলা"
      title="Admin Login"
      intro="Owner, inventory, finance and desk staff. Sign in with your email and password."
      next="/admin"
      otherLabel="Gate staff (scanner / supervisor)? Use Gate Staff Login"
      otherHref="/gate/login"
    />
  );
}
