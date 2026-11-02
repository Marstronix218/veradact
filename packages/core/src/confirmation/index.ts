// Client confirmation flow (ARCHITECTURE §8): signed links, channels, the client view and actions.
export { AUTHORIZATION_TEXT_VERSION, renderAuthorizationText, type AuthorizationTextInput } from "./authorization-text";
export {
  signLinkToken,
  parseLinkToken,
  clientLinkUrl,
  linkSigningSecret,
  resolveClientLink,
  type LinkTokenInput,
  type ClientLinkContext,
  type ResolveClientLinkResult,
} from "./link-token";
export {
  EmailLinkChannel,
  sendConfirmationRequest,
  loadDeliveryContext,
  buildDelivery,
  type ConfirmationChannel,
  type ConfirmationDelivery,
  type DeliveryContext,
  type SendConfirmationRequestInput,
  type SendConfirmationRequestResult,
  type LinkDeliveryResult,
} from "./channels";
export {
  loadClientView,
  buildClientView,
  type ClientView,
  type ClientViewItem,
  type ClientQuote,
  type ClientAuthorizationStatus,
} from "./client-view";
export {
  CLIENT_PAGE_RATE_LIMITS,
  checkClientPageRateLimit,
  recordLinkOpen,
  recordLinkInteraction,
  clientAuthorize,
  clientSubmit,
  validateClientResponses,
  type ClientLinkHandle,
  type ClientAuthorizeInput,
  type ClientAuthorizeResult,
  type ClientFormResponse,
  type ClientFieldError,
  type ClientReceipt,
  type ClientReceiptItem,
  type ClientSubmitInput,
  type ClientSubmitResult,
} from "./client-actions";
export { listOpenDisputes, type OpenDispute } from "./vendor-queries";
export { formatDateTime, formatLongDate, formatShortDate } from "./format";
export { confirmationLinkEmail, receiptEmail, disputeNotificationEmail, declineNotificationEmail, type VendorNoticeInput } from "./emails";
