using System;
using System.IO;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.Runtime
{
    // The caller serializes catalog writes while this operation is in flight.
    // Pending state is durable before either stopping or contacting the server.
    public sealed class BridgeProfileRemovalService
    {
        private readonly BridgeProfileStore store;
        private readonly IBridgeCredentialRevoker revoker;
        private readonly Action<string> stop;
        public BridgeProfileRemovalService(BridgeProfileStore value, IBridgeCredentialRevoker credentialRevoker, Action<string> stopProfile)
        {
            if (value == null || credentialRevoker == null || stopProfile == null) throw new ArgumentNullException("bridge_profile_removal_configuration");
            store = value;
            revoker = credentialRevoker;
            stop = stopProfile;
        }

        public BridgeProfileCatalog Prepare(BridgeProfileCatalog catalog, string profileId)
        {
            BridgeProfileCatalog pending = Copy(catalog);
            BridgeProfileSettings profile = Find(pending, profileId);
            profile.RemovalPending = true;
            profile.AutoConnect = false;
            store.Save(pending);
            return pending;
        }

        public BridgeProfileCatalog Complete(BridgeProfileCatalog catalog, string profileId)
        {
            BridgeProfileCatalog complete = Copy(catalog);
            BridgeProfileSettings profile = Find(complete, profileId);
            if (!profile.RemovalPending || profile.AutoConnect) throw new InvalidDataException("bridge_profile_removal_not_prepared");
            stop(profileId);
            string token = store.ReadRefreshToken(profile);
            try { revoker.Revoke(profile, token); }
            finally { token = null; }
            complete.Profiles.Remove(profile);
            store.Save(complete);
            return complete;
        }

        private static BridgeProfileCatalog Copy(BridgeProfileCatalog catalog)
        {
            BridgeProfileStore.Validate(catalog, false);
            BridgeProfileCatalog result = new BridgeProfileCatalog { InstallationId = catalog.InstallationId, SchemaVersion = catalog.SchemaVersion };
            foreach (BridgeProfileSettings profile in catalog.Profiles) result.Profiles.Add(profile.Clone());
            return result;
        }
        private static BridgeProfileSettings Find(BridgeProfileCatalog catalog, string id)
        {
            foreach (BridgeProfileSettings profile in catalog.Profiles) if (profile.ProfileId == id) return profile;
            throw new InvalidDataException("bridge_profile_removal_not_found");
        }
    }
}
