using System;
using Liangjian.BridgeV4.Transport;

namespace Liangjian.BridgeV4.Runtime
{
    public interface IBridgeMessageChannel : IBridgeMessageSink, IDisposable
    {
        string Receive();
    }

    public sealed class Rfc6455MessageChannel : IBridgeMessageChannel
    {
        private readonly Rfc6455Transport transport;

        private Rfc6455MessageChannel(Rfc6455Transport transportValue)
        {
            transport = transportValue;
        }

        public static Rfc6455MessageChannel Connect(Uri uri, string bearerToken, int timeoutMilliseconds)
        {
            Rfc6455Transport transport = new Rfc6455Transport();
            try
            {
                transport.Connect(uri, bearerToken, timeoutMilliseconds);
                return new Rfc6455MessageChannel(transport);
            }
            catch
            {
                transport.Dispose();
                throw;
            }
        }

        public string Receive()
        {
            return transport.ReceiveText();
        }

        public void Send(string envelopeJson)
        {
            transport.SendText(envelopeJson);
        }

        public void Dispose()
        {
            transport.Dispose();
        }
    }

    public sealed class BridgeProfileConnection
    {
        private readonly BridgeProfileSession session;
        private readonly IBridgeMessageChannel channel;

        public BridgeProfileConnection(BridgeProfileSession sessionValue, IBridgeMessageChannel channelValue)
        {
            if (sessionValue == null || channelValue == null)
            {
                throw new ArgumentNullException("sessionValue");
            }
            session = sessionValue;
            channel = channelValue;
        }

        public bool ProcessNext(long nowUtcMsc)
        {
            string incoming = channel.Receive();
            if (incoming == null)
            {
                return false;
            }
            string response = session.Handle(incoming, nowUtcMsc);
            if (response != null)
            {
                channel.Send(response);
                session.AfterResponseSent(nowUtcMsc);
            }
            return true;
        }
    }
}
