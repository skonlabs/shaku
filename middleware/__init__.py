"""Token-optimization middleware for OpenAI and Anthropic API calls."""
from .budget_manager import BudgetManager, TASK_OUTPUT_TOKENS
from .cache_layer import CacheLayer
from .context_pruner import ContextPruner
from .history_compressor import ExtractiveSummarizer, HistoryCompressor
from .input_cleaner import InputCleaner
from .middleware import TokenOptimizationMiddleware
from .prompt_normalizer import PromptNormalizer
from .token_counter import TokenCounter
from .types import (
    Message,
    OptimizationConfig,
    OptimizationResult,
    Provider,
    TaskType,
    TokenBudget,
)

__all__ = [
    # Main orchestrator
    "TokenOptimizationMiddleware",
    # Individual components
    "TokenCounter",
    "InputCleaner",
    "PromptNormalizer",
    "HistoryCompressor",
    "ExtractiveSummarizer",
    "ContextPruner",
    "BudgetManager",
    "CacheLayer",
    # Types
    "Message",
    "OptimizationConfig",
    "OptimizationResult",
    "Provider",
    "TaskType",
    "TokenBudget",
    # Constants
    "TASK_OUTPUT_TOKENS",
]
