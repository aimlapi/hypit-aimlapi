# `@hypit/credential-store-platform`

An explicitly selected CredentialStore policy: macOS Keychain on macOS, Windows Credential Locker
on Windows, and an unencrypted, owner-private file on Linux. Other platforms are unsupported by this
package and report an error. Linux may offer other credential services; this package chooses file
storage there and does not detect or integrate those services.

A Profile can select this package to use that policy on Linux, macOS and Windows.
`@hypit/credential-store-os`, `@hypit/credential-store-file` and `@hypit/credential-store-env`
remain selectable directly for a deployment with a different storage choice.

## Select it

```json
{
  "credentials": {
    "platform": { "use": "@hypit/credential-store-platform" }
  },
  "endpoints": {
    "hypihub.default": {
      "use": "@hypit/provider-hypihub",
      "config": {
        "baseUrl": "https://hypit.ai",
        "apiKey": { "store": "platform", "key": "hypihub.oauth" }
      }
    }
  }
}
```

The Endpoint still owns its acquisition flow and the Store only persists the result:

```bash
hypit auth login hypihub.default --runtime <profile>
hypit auth status hypihub.default --runtime <profile>
hypit auth logout hypihub.default --runtime <profile>
```

## What it does not do

The choice is made once per host, from the platform the Runtime is running on. This is not a lookup
chain: a miss or failure in one store never tries another, and no credential is migrated between them. A
credential stored in a locker stays in that locker; a credential stored in a file stays in that file.

## Configuration

- `path` selects the directory for Linux file storage, resolved against the Host state root printed by
  `hypit paths`. The default is the same `credentials` directory `@hypit/credential-store-file` uses,
  so on Linux, switching between the two Stores finds the credential already stored.
- `service` selects the locker service name. The OS Store's own default applies when it is absent.

## Storage on each platform

On macOS and Windows the credential is held by the platform locker, with exactly the rules of
`@hypit/credential-store-os`: it is encrypted and access-controlled by the operating system, and it
follows that locker’s access and synchronization policy. Windows Credential Locker may roam
credentials through the user’s Microsoft account.

On Linux the credential is held by an owner-private document with exactly the rules of
`@hypit/credential-store-file`: unencrypted JSON, one document per key, directory mode `0700`, file
mode `0600`, outside the video project, and never enumerated or indexed. Filesystem path-length
limits apply to an overlong key, which fails rather than selecting another name. A damaged document
can be replaced by `auth login` or deleted by `auth logout` without decoding the old value.
