// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import * as React from "react";

interface IconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

export const GmailIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
      fill="#EA4335"
    />
  </svg>
);

export const GoogleCalendarIcon: React.FC<IconProps> = ({
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
    <path d="M5.684 24v-5.684h12.632V24H5.684z" fill="#1967D2" />
    <path
      d="M18.316 24V18.316H24V22.5c0 .828-.672 1.5-1.5 1.5h-4.184z"
      fill="#1967D2"
    />
    <path d="M5.684 5.684h12.632v12.632H5.684V5.684z" fill="#fff" />
    <path d="M0 5.684h5.684v12.632H0V5.684z" fill="#FBBC04" />
    <path d="M5.684 0h12.632v5.684H5.684V0z" fill="#34A853" />
    <path
      d="M5.684 18.316V24H1.5A1.5 1.5 0 0 1 0 22.5v-4.184h5.684z"
      fill="#188038"
    />
    <path
      d="M0 5.684V1.5C0 .672.672 0 1.5 0h4.184v5.684H0z"
      fill="#188038"
    />
    <path
      d="M18.316 0H22.5c.828 0 1.5.672 1.5 1.5v4.184h-5.684V0z"
      fill="#1967D2"
    />
    <path
      d="M14.109 15.996c-.469.312-1.063.468-1.781.468-.844 0-1.547-.265-2.109-.797a2.68 2.68 0 0 1-.844-1.984h1.266c.015.5.187.906.515 1.219.328.312.75.468 1.266.468.453 0 .828-.125 1.125-.375.297-.25.446-.578.446-.984 0-.422-.149-.758-.446-1.008-.297-.25-.695-.375-1.196-.375h-.75v-1.078h.68c.437 0 .789-.11 1.054-.328.266-.219.399-.524.399-.914 0-.375-.118-.672-.352-.891-.234-.219-.562-.328-.984-.328-.422 0-.766.125-1.032.375-.265.25-.414.586-.445 1.008H9.656c.032-.734.312-1.336.844-1.805.531-.469 1.203-.703 2.015-.703.828 0 1.493.227 1.993.68.5.453.75 1.047.75 1.781 0 .484-.133.899-.399 1.243-.265.344-.617.586-1.055.727v.046c.532.11.954.352 1.266.727.312.375.469.836.469 1.383 0 .734-.282 1.336-.844 1.805-.563.469-1.282.703-2.157.703z"
      fill="#4285F4"
    />
    <path
      d="M8.32 8.227v6.82H7.055V9.54l-1.64.562V8.977l2.695-.75h.21z"
      fill="#4285F4"
    />
  </svg>
);

export const GoogleContactsIcon: React.FC<IconProps> = ({
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      fill="#1A73E8"
    />
  </svg>
);

export const GoogleSheetsIcon: React.FC<IconProps> = ({
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
      fill="#0F9D58"
    />
    <path d="M14 2v6h6l-6-6z" fill="#87CEAC" />
    <path
      d="M16 13H8v5h8v-5z"
      fill="#fff"
      stroke="#0F9D58"
      strokeWidth=".5"
    />
    <path d="M12 13v5M8 15.5h8" stroke="#0F9D58" strokeWidth=".5" />
  </svg>
);

export const GoogleFormsIcon: React.FC<IconProps> = ({
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
      fill="#673AB7"
    />
    <path d="M14 2v6h6l-6-6z" fill="#B39DDB" />
    <circle cx="8" cy="12" r="1" fill="#fff" />
    <path d="M11 12h5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="15" r="1" fill="#fff" />
    <path d="M11 15h5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="18" r="1" fill="#fff" />
    <path d="M11 18h5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const GoogleDriveIcon: React.FC<IconProps> = ({
  className,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path d="M8 2l8 14H0L8 2z" fill="#0F9D58" />
    <path d="M16 2l8 14h-8L8 2h8z" fill="#FBBC04" />
    <path d="M24 16l-4 6H4l4-6h16z" fill="#4285F4" />
  </svg>
);
