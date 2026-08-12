import { redirect } from 'next/navigation'

/** The fixture walkthrough was retired when the dashboard moved to real integrations. */
export default function RetiredDemoPage(): never {
  redirect('/integrations')
}
