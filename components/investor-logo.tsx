import { CompanyLogo } from "@/components/company-logo";
import { investorInitials } from "@/lib/logo";

export { investorInitials };

interface InvestorLogoProps {
  name: string;
  /** The investor's id, which the logo route looks it up by. */
  id?: string;
  /** The firm's website, as the investor resolve step stored it; none shows the monogram. */
  domain?: string | null;
  /** The logo the branding format read off that website; tried after the favicon, as a company's is. */
  logoUrl?: string | null;
  size?: number;
  className?: string;
}

/**
 * An investor's tile: the same route, fallback chain, and dark-mode handling as a company's (the
 * favicon by domain, then the stored branding logo, then the monogram), with initials in the monogram.
 */
export function InvestorLogo({ name, id, domain, logoUrl, size = 20, className }: InvestorLogoProps) {
  return (
    <CompanyLogo
      name={name}
      id={id}
      kind="investor"
      domain={domain}
      logoUrl={logoUrl}
      size={size}
      mark={investorInitials(name)}
      className={className}
    />
  );
}
