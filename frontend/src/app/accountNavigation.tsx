import {
  Link as RouterLink,
  NavLink as RouterNavLink,
  useResolvedPath,
  useLocation,
  type To,
} from 'react-router';
import type { ComponentProps } from 'react';
import { useAccounts } from './accounts';

export function useAccountPath(to: To) {
  const { selected, overview } = useAccounts();
  const location = useLocation();
  const resolved = useResolvedPath(to);
  const account = selected ?? (overview?.accounts.length === 1 ? overview.accounts[0]!.id : null);
  if (
    !account ||
    (selected &&
      (overview?.accounts.length ?? 0) <= 1 &&
      !new URLSearchParams(location.search).has('account'))
  )
    return to;
  const params = new URLSearchParams(resolved.search);
  if (!params.has('account')) params.set('account', account);
  return { ...resolved, search: `?${params}` };
}

export function Link(props: ComponentProps<typeof RouterLink>) {
  return <RouterLink {...props} to={useAccountPath(props.to)} />;
}

export function NavLink(props: ComponentProps<typeof RouterNavLink>) {
  return <RouterNavLink {...props} to={useAccountPath(props.to)} />;
}
