using System;
using System.Collections.Generic;

namespace Liangjian.BridgeV4.Storage
{
    public sealed class ProfileStateRecord
    {
        public string ProfileId { get; set; }
        public string TerminalInstanceId { get; set; }
        public string Platform { get; set; }
        public string BrokerServer { get; set; }
        public string Login { get; set; }
        public long ConnectionEpoch { get; set; }
        public int TerminalBuild { get; set; }
        public int? ClockOffsetSeconds { get; set; }
        public string ClockStatus { get; set; }
        public string ClockRevision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
    }

    public sealed class SchemaMigrationRecord
    {
        public int Version { get; set; }
        public string Name { get; set; }
        public string Checksum { get; set; }
        public long AppliedAtUtcMsc { get; set; }
    }

    public sealed class StreamStateRecord
    {
        public string Resource { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Revision { get; set; }
        public string PayloadHash { get; set; }
        public long? SourceTimeUtcMsc { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public string Status { get; set; }
    }

    public sealed class AccountLatestRecord
    {
        public long ConnectionEpoch { get; set; }
        public string Revision { get; set; }
        public string AccountNumber { get; set; }
        public string Currency { get; set; }
        public decimal? Balance { get; set; }
        public decimal? Equity { get; set; }
        public decimal? Margin { get; set; }
        public decimal? FreeMargin { get; set; }
        public decimal? MarginLevel { get; set; }
        public decimal? Profit { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public string FactJson { get; set; }
    }

    public sealed class PositionLatestRecord
    {
        public string Ticket { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Revision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public string Symbol { get; set; }
        public string Direction { get; set; }
        public decimal Volume { get; set; }
        public decimal? OpenPrice { get; set; }
        public decimal? StopLoss { get; set; }
        public decimal? TakeProfit { get; set; }
        public decimal? CurrentPrice { get; set; }
        public decimal? Profit { get; set; }
        public string FactJson { get; set; }
    }

    public sealed class PendingOrderLatestRecord
    {
        public string Ticket { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Revision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public string Symbol { get; set; }
        public string OrderType { get; set; }
        public string Direction { get; set; }
        public decimal Volume { get; set; }
        public decimal? RequestedPrice { get; set; }
        public decimal? StopLoss { get; set; }
        public decimal? TakeProfit { get; set; }
        public string FactJson { get; set; }
    }

    public sealed class InstrumentCacheRecord
    {
        public string Symbol { get; set; }
        public int TerminalBuild { get; set; }
        public string SpecRevision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public long LastAccessedUtcMsc { get; set; }
        public long ExpiresAtUtcMsc { get; set; }
        public string FactJson { get; set; }
    }

    public sealed class InstrumentCacheCursor
    {
        public InstrumentCacheCursor()
        {
        }

        public InstrumentCacheCursor(string symbol)
        {
            Symbol = symbol;
        }

        public string Symbol { get; set; }
    }

    public sealed class InstrumentCachePage
    {
        public IList<InstrumentCacheRecord> Items { get; set; }
        public InstrumentCacheCursor NextCursor { get; set; }
        public bool HasMore { get; set; }
    }

    public sealed class SyncJobCursor
    {
        public SyncJobCursor()
        {
        }

        public SyncJobCursor(long updatedAtUtcMsc, string jobId)
        {
            UpdatedAtUtcMsc = updatedAtUtcMsc;
            JobId = jobId;
        }

        public long UpdatedAtUtcMsc { get; set; }
        public string JobId { get; set; }
    }

    public sealed class SyncJobPage
    {
        public IList<SyncJobRecord> Items { get; set; }
        public SyncJobCursor NextCursor { get; set; }
        public bool HasMore { get; set; }
    }

    public sealed class SyncJobRecord
    {
        public string JobId { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public string Cursor { get; set; }
        public string State { get; set; }
        public string LeaseOwner { get; set; }
        public long? LeaseExpiresAtUtcMsc { get; set; }
        public int Attempt { get; set; }
        public long NextAttemptAtUtcMsc { get; set; }
        public string LastErrorCode { get; set; }
        public string LastErrorDetail { get; set; }
        public long CreatedAtUtcMsc { get; set; }
        public long UpdatedAtUtcMsc { get; set; }
    }

    public sealed class OutboxMessageRecord
    {
        public string MessageId { get; set; }
        public long ConnectionEpoch { get; set; }
        public string MessageKind { get; set; }
        public string PayloadJson { get; set; }
        public int Priority { get; set; }
        public long NextAttemptAtUtcMsc { get; set; }
        public int Attempt { get; set; }
        public long? AckedAtUtcMsc { get; set; }
        public long CreatedAtUtcMsc { get; set; }
        public string LastErrorCode { get; set; }
        public string LastErrorDetail { get; set; }
    }

    public sealed class OutboxCursor
    {
        public OutboxCursor()
        {
        }

        public OutboxCursor(int priority, long nextAttemptAtUtcMsc, long createdAtUtcMsc, string messageId)
        {
            Priority = priority;
            NextAttemptAtUtcMsc = nextAttemptAtUtcMsc;
            CreatedAtUtcMsc = createdAtUtcMsc;
            MessageId = messageId;
        }

        public int Priority { get; set; }
        public long NextAttemptAtUtcMsc { get; set; }
        public long CreatedAtUtcMsc { get; set; }
        public string MessageId { get; set; }
    }

    public sealed class OutboxPage
    {
        public IList<OutboxMessageRecord> Items { get; set; }
        public OutboxCursor NextCursor { get; set; }
        public bool HasMore { get; set; }
    }

    public sealed class MaintenanceStateRecord
    {
        public long? LastCleanupAtUtcMsc { get; set; }
        public long? LastCheckpointAtUtcMsc { get; set; }
        public long? LastDiskCheckAtUtcMsc { get; set; }
        public long? DiskUsedBytes { get; set; }
        public long? DiskFreeBytes { get; set; }
        public string DiskWatermark { get; set; }
        public string LastErrorCode { get; set; }
        public long? LastErrorAtUtcMsc { get; set; }
        public int CleanupCursor { get; set; }
        public long UpdatedAtUtcMsc { get; set; }
    }

    public sealed class CandleRecord
    {
        public string Symbol { get; set; }
        public string Timeframe { get; set; }
        public long OpenTimeUtcMsc { get; set; }
        public double Open { get; set; }
        public double High { get; set; }
        public double Low { get; set; }
        public double Close { get; set; }
        public long TickVolume { get; set; }
        public long RealVolume { get; set; }
        public double Spread { get; set; }
        public bool Closed { get; set; }
        public string SourceRevision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public long LastAccessedUtcMsc { get; set; }
    }

    public sealed class HistoryItemRecord
    {
        public string ItemKind { get; set; }
        public string ItemId { get; set; }
        public long EventTimeUtcMsc { get; set; }
        public string Ticket { get; set; }
        public string OrderId { get; set; }
        public string PositionId { get; set; }
        public string Symbol { get; set; }
        public string FundsKind { get; set; }
        public decimal? Amount { get; set; }
        public string FactJson { get; set; }
        public string SourceRevision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public long LastAccessedUtcMsc { get; set; }
    }

    public sealed class CoverageRangeRecord
    {
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public string Completeness { get; set; }
        public string SourceRevision { get; set; }
        public long UpdatedAtUtcMsc { get; set; }
    }

    public sealed class ServerCoverageAckRecord
    {
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public string SourceRevision { get; set; }
        public long AckedAtUtcMsc { get; set; }
    }

    public sealed class QuerySnapshotRecord
    {
        public string SnapshotId { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public string QueryHash { get; set; }
        public string FrozenRevision { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public long CreatedAtUtcMsc { get; set; }
        public long ExpiresAtUtcMsc { get; set; }
    }

    public sealed class CandleCursor
    {
        public CandleCursor()
        {
        }

        public CandleCursor(long openTimeUtcMsc)
        {
            OpenTimeUtcMsc = openTimeUtcMsc;
        }

        public long OpenTimeUtcMsc { get; set; }
    }

    public sealed class HistoryCursor
    {
        public HistoryCursor()
        {
        }

        public HistoryCursor(long eventTimeUtcMsc, string itemId)
        {
            EventTimeUtcMsc = eventTimeUtcMsc;
            ItemId = itemId;
        }

        public long EventTimeUtcMsc { get; set; }
        public string ItemId { get; set; }
    }

    public sealed class CandlePage
    {
        public IList<CandleRecord> Items { get; set; }
        public CandleCursor NextCursor { get; set; }
        public bool HasMore { get; set; }
    }

    public sealed class HistoryPage
    {
        public IList<HistoryItemRecord> Items { get; set; }
        public HistoryCursor NextCursor { get; set; }
        public bool HasMore { get; set; }
    }

    public sealed class CacheCleanupResult
    {
        public int QuerySnapshotsDeleted { get; set; }
        public int CandlesDeleted { get; set; }
        public int HistoryItemsDeleted { get; set; }
        public int InstrumentsDeleted { get; set; }
        public int StaleProjectionsDeleted { get; set; }
        public int SyncJobsDeleted { get; set; }
        public int OutboxMessagesDeleted { get; set; }
        public int TotalDeleted
        {
            get { return QuerySnapshotsDeleted + CandlesDeleted + HistoryItemsDeleted + InstrumentsDeleted + StaleProjectionsDeleted + SyncJobsDeleted + OutboxMessagesDeleted; }
        }
    }

    internal sealed class CandleCleanupKey
    {
        public string Symbol { get; set; }
        public string Timeframe { get; set; }
        public long OpenTimeUtcMsc { get; set; }
    }

    internal sealed class HistoryCleanupKey
    {
        public string ItemKind { get; set; }
        public string ItemId { get; set; }
        public string Symbol { get; set; }
        public long EventTimeUtcMsc { get; set; }
    }

    internal sealed class CleanupBounds
    {
        public string Kind { get; set; }
        public string ScopeSymbol { get; set; }
        public long MinimumUtcMsc { get; set; }
        public long MaximumUtcMsc { get; set; }
    }
}
