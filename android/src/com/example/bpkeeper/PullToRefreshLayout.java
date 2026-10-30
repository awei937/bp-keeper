package com.example.bpkeeper;

import android.content.Context;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 极简下拉刷新容器（不依赖 AndroidX SwipeRefreshLayout）。
 * 布局中第一个子 View 为刷新头（64dp，平时隐藏在顶部之外），第二个子 View 为内容（WebView）。
 */
public class PullToRefreshLayout extends FrameLayout {

    public interface OnRefreshListener {
        void onRefresh();
    }

    private static final int HEADER_HEIGHT_DP = 64;
    private static final float DRAG_RATE = 0.55f;
    private static final float TRIGGER_RATIO = 0.72f;
    private static final int ANIM_DURATION = 220;

    private final DecelerateInterpolator interpolator = new DecelerateInterpolator();
    private final int touchSlop;
    private final int headerHeight;

    private View header;
    private View content;
    private ProgressBar headerProgress;
    private TextView headerText;
    private OnRefreshListener refreshListener;

    private boolean enabled = true;
    private boolean refreshing;
    private boolean dragging;
    private boolean canPull;
    private float startX;
    private float startY;
    private float pull;

    public PullToRefreshLayout(Context context) {
        this(context, null);
    }

    public PullToRefreshLayout(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public PullToRefreshLayout(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        float density = getResources().getDisplayMetrics().density;
        headerHeight = (int) (HEADER_HEIGHT_DP * density + 0.5f);
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
    }

    public void setOnRefreshListener(OnRefreshListener listener) {
        this.refreshListener = listener;
    }

    public void setPullEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isRefreshing() {
        return refreshing;
    }

    public void setRefreshing(boolean value) {
        if (value) {
            if (!refreshing) {
                refreshing = true;
                showRefreshingUi();
            }
        } else if (refreshing) {
            refreshing = false;
            animateBack();
        }
    }

    @Override
    protected void onFinishInflate() {
        super.onFinishInflate();
        if (getChildCount() < 2) {
            throw new IllegalStateException("PullToRefreshLayout needs two children: header + content");
        }
        header = getChildAt(0);
        content = getChildAt(1);
        headerProgress = header.findViewById(R.id.refresh_progress);
        headerText = header.findViewById(R.id.refresh_text);
        header.setTranslationY(-headerHeight);
        updateHeaderText(0);
    }

    private boolean isContentAtTop() {
        return content != null && content.getScrollY() <= 0;
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        if (!enabled || refreshing || content == null) {
            return false;
        }
        final int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            startX = ev.getX();
            startY = ev.getY();
            dragging = false;
            canPull = isContentAtTop();
            return false;
        }
        if (action == MotionEvent.ACTION_MOVE) {
            if (!canPull || !isContentAtTop()) {
                return false;
            }
            float dy = ev.getY() - startY;
            float dx = Math.abs(ev.getX() - startX);
            if (dy > touchSlop && dy > dx) {
                dragging = true;
                pull = 0f;
                return true;
            }
            return false;
        }
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            dragging = false;
            canPull = false;
            return false;
        }
        return false;
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        if (!dragging) {
            return super.onTouchEvent(ev);
        }
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_MOVE: {
                float dy = ev.getY() - startY;
                if (dy < 0) {
                    dy = 0;
                }
                pull = dy * DRAG_RATE;
                float max = headerHeight * 1.6f;
                if (pull > max) {
                    pull = max;
                }
                applyPull(pull);
                updateHeaderText(pull);
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                boolean trigger = pull >= headerHeight * TRIGGER_RATIO;
                dragging = false;
                if (trigger) {
                    startRefresh();
                } else {
                    animateBack();
                }
                return true;
            }
            default:
                return true;
        }
    }

    private void applyPull(float distance) {
        if (content != null) {
            content.setTranslationY(distance);
        }
        if (header != null) {
            header.setTranslationY(distance - headerHeight);
        }
    }

    private void updateHeaderText(float distance) {
        if (headerText == null) {
            return;
        }
        if (distance >= headerHeight * TRIGGER_RATIO) {
            headerText.setText(R.string.release_to_refresh);
        } else {
            headerText.setText(R.string.pull_to_refresh);
        }
    }

    private void showRefreshingUi() {
        pull = headerHeight;
        if (headerProgress != null) {
            headerProgress.setVisibility(View.VISIBLE);
        }
        if (headerText != null) {
            headerText.setText(R.string.refreshing);
        }
        if (content != null) {
            content.animate().translationY(headerHeight).setDuration(ANIM_DURATION)
                    .setInterpolator(interpolator).start();
        }
        if (header != null) {
            header.animate().translationY(0).setDuration(ANIM_DURATION)
                    .setInterpolator(interpolator).start();
        }
    }

    private void startRefresh() {
        if (refreshing) {
            return;
        }
        refreshing = true;
        showRefreshingUi();
        if (refreshListener != null) {
            refreshListener.onRefresh();
        }
    }

    private void animateBack() {
        pull = 0f;
        if (headerProgress != null) {
            headerProgress.setVisibility(View.GONE);
        }
        updateHeaderText(0);
        if (content != null) {
            content.animate().translationY(0).setDuration(ANIM_DURATION)
                    .setInterpolator(interpolator).start();
        }
        if (header != null) {
            header.animate().translationY(-headerHeight).setDuration(ANIM_DURATION)
                    .setInterpolator(interpolator).start();
        }
    }
}
